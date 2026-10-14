import { Schema } from "effect"
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context"
import {
  AssistantEntry,
  ProviderDoc,
  UsageDoc,
  configure,
  defineDoc,
  type ConversationId,
  type Harness,
  type EntryId,
} from "@earendil-works/pi-durable"
import { BackgroundHandoff, backgroundEffect } from "../background"
import { Control, DelegationFailure, type Group } from "../contracts"
import { REQUEST_LIMIT } from "../delegation"

const State = Schema.Struct({
  handoff: BackgroundHandoff,
  stopped: Schema.Boolean,
  sealed: Schema.Boolean,
  revision: Schema.Number,
  children: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      provider: Schema.String,
      requests: Schema.Number,
      stopped: Schema.Boolean,
    })
  ),
  controls: Schema.Array(Control),
  applied: Schema.Array(Schema.String),
})
type State = typeof State.Type
const Document = defineDoc({
  kind: "delegation.background",
  version: 1,
  scope: "session",
  initial: () => ({ value: "" }),
})
const decode = (value: string) =>
  Schema.decodeUnknownSync(State)(JSON.parse(value))
export async function readBackgroundHandoff(h: Harness) {
  const document = await h.snapshot(Document, context)
  return document?.value ? decode(document.value).handoff : undefined
}
const fail = (code: DelegationFailure["code"], message: string) =>
  new DelegationFailure({ code, message })
const requestId = (child: number) => `background-initial:${child}`
const controlId = (input: Control) => `background-control:${input.operationId}`
const trim = (value: string, limit = 12000) => {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= limit
    ? value
    : new TextDecoder().decode(bytes.slice(0, limit), { stream: true }) +
        "\n[Shortened; full answer is in the native transcript.]"
}

export function piBackgroundGroup(
  open: () => Promise<Harness>,
  bridge: {
    submit: (
      child: number,
      text: string,
      operationId: string,
      steer: boolean
    ) => Promise<unknown>
    abort: (child: number) => Promise<unknown>
  },
  now: () => number = Date.now
) {
  const load = async (h: Harness): Promise<State> => {
    const document = await h.snapshot(Document, context)
    if (!document?.value)
      throw fail("not_found", "This background group is unavailable.")
    return decode(document.value)
  }
  const edit = async <T>(
    h: Harness,
    body: (state: State) => { state: State; result: T }
  ) =>
    h.commit(async (tx) => {
      const document = await tx.doc(Document)
      if (!document.value)
        throw fail("not_found", "This background group is unavailable.")
      const change = body(decode(document.value))
      document.value = JSON.stringify(change.state)
      return change.result
    }, context)
  const project = async (h: Harness, state: State): Promise<Group> => {
    const children: Group["children"][number][] = []
    for (const [index, child] of state.children.entries()) {
      const records = await h.commit(async (tx) => {
        const ids = [
          requestId(child.id),
          ...state.controls
            .filter((c) => c.childId === child.id && c.action.type === "steer")
            .map(controlId),
        ]
        return Promise.all(
          ids.map((id) =>
            tx.submissionByRequest(child.id as ConversationId, id)
          )
        )
      }, context)
      const answer = records
        .filter((r) => r?.type === "input" && r.status === "done")
        .sort((a, b) => b.answer - a.answer)[0]
      const entry = answer
        ? await h.commit(
            (tx) => tx.entry(AssistantEntry, answer.answer),
            context
          )
        : undefined
      const text = (entry?.model ?? [])
        .flatMap((m) =>
          Array.isArray(m.content)
            ? m.content.filter((p) => p.type === "text").map((p) => p.text)
            : []
        )
        .join("\n")
      const stopped =
        state.stopped ||
        child.stopped ||
        (!state.sealed && now() >= state.handoff.deadline)
      const pending = records.some(
        (r) =>
          r?.status === "queued" || r?.status === "placed" || (!r && !stopped)
      )
      const failed = records.some((r) => !r || r.status === "unanswered")
      const usage = await h.snapshot(
        UsageDoc,
        child.id as ConversationId,
        context
      )
      const totals = Object.values(usage?.models ?? {})
      children.push({
        ...state.handoff.input.tasks[index]!,
        id: child.id,
        status: pending
          ? stopped
            ? "stopping"
            : "working"
          : stopped
            ? "cancelled"
            : failed
              ? "failed"
              : "completed",
        answer: trim(text),
        requests: child.requests,
        inputTokens: totals.length
          ? totals.reduce((n, u) => n + u.input + u.cacheRead + u.cacheWrite, 0)
          : null,
        outputTokens: totals.length
          ? totals.reduce((n, u) => n + u.output, 0)
          : null,
        steering: state.controls
          .filter((c) => c.childId === child.id && c.action.type === "steer")
          .map((c) => (c.action.type === "steer" ? c.action.text : "")),
        error:
          failed && !pending && !stopped
            ? child.requests >= REQUEST_LIMIT
              ? "This child reached its request limit."
              : "The model did not complete this task."
            : null,
      })
    }
    return {
      id: state.handoff.id,
      turnId: state.handoff.turnId,
      conversationId: state.handoff.conversationId,
      objective: state.handoff.input.objective,
      route: state.handoff.route,
      createdAt: state.handoff.createdAt,
      deadline: state.handoff.deadline,
      status: state.stopped
        ? "cancelled"
        : state.sealed
          ? "completed"
          : "working",
      children,
    }
  }
  const drain = async (h: Harness) => {
    const state = await load(h)
    for (const input of state.controls) {
      const latest = await load(h)
      if (latest.applied.includes(input.operationId)) continue
      const child = latest.children.find((c) => c.id === input.childId)!
      if (
        input.action.type === "stop" ||
        latest.stopped ||
        child.stopped ||
        now() >= latest.handoff.deadline
      ) {
        await bridge.abort(child.id)
      } else if (!latest.sealed) {
        const initial = await h.commit(
          (tx) =>
            tx.submissionByRequest(
              child.id as ConversationId,
              requestId(child.id)
            ),
          context
        )
        if (!initial) continue
        await bridge.submit(child.id, input.action.text, controlId(input), true)
      }
      await edit(h, (value) => ({
        state: {
          ...value,
          applied: [...new Set([...value.applied, input.operationId])],
        },
        result: undefined,
      }))
    }
  }
  return {
    pin: () =>
      backgroundEffect(async () => {
        const h = await open(),
          doc = await h.snapshot(Document, context)
        return doc?.value ? decode(doc.value).handoff : undefined
      }),
    initialize: (raw: BackgroundHandoff) =>
      backgroundEffect(async () => {
        const handoff = Schema.decodeUnknownSync(BackgroundHandoff)(raw),
          h = await open()
        if (handoff.input.tasks.some((t) => t.tools.length))
          throw fail("invalid", "Background tasks have no tool grants.")
        await h.commit(async (tx) => {
          const document = await tx.doc(Document)
          if (document.value) {
            if (
              JSON.stringify(decode(document.value).handoff) !==
              JSON.stringify(handoff)
            )
              throw fail(
                "conflict",
                "This group already has a different handoff."
              )
            return
          }
          const children = []
          for (const task of handoff.input.tasks) {
            const child = await tx.createConversation({
              ownership: { kind: "ownerless" },
            })
            await configure(tx, child.id, {
              model: { provider: "openai", modelId: handoff.route.model },
              thinkingLevel: handoff.route.thinking,
              extensions: [],
              tools: [],
              instructions: `You are the background drafting child ${task.name}. Work only on the supplied task and text reference. You have no tools, live retrieval, images, outside-action authority or delegation. Report uncertainty and missing evidence explicitly. Respect all constraints and later steering.\n<reference>\n${handoff.memory}\n</reference>`,
            })
            const provider = await tx.doc(ProviderDoc, child.id)
            children.push({
              id: Number(child.id),
              provider: provider.sessionId,
              requests: 0,
              stopped: false,
            })
          }
          document.value = JSON.stringify({
            handoff,
            children,
            stopped: false,
            sealed: false,
            revision: 0,
            controls: [],
            applied: [],
          } satisfies State)
        }, context)
      }),
    advance: () =>
      backgroundEffect(async () => {
        const h = await open(),
          state = await load(h)
        if (!state.sealed && now() >= state.handoff.deadline)
          await edit(h, (current) => ({
            state:
              current.sealed || current.stopped
                ? current
                : { ...current, stopped: true, revision: current.revision + 1 },
            result: undefined,
          }))
        for (const [index, child] of state.children.entries()) {
          const latest = await load(h)
          if (latest.sealed) break
          if (
            latest.stopped ||
            latest.children[index]!.stopped ||
            now() >= latest.handoff.deadline
          )
            await bridge.abort(child.id)
          else
            await bridge.submit(
              child.id,
              latest.handoff.input.tasks[index]!.task,
              requestId(child.id),
              false
            )
        }
        await drain(h)
        const latest = await load(h),
          view = await project(h, latest)
        if (
          !view.children.some((c) =>
            ["queued", "working", "stopping"].includes(c.status)
          )
        )
          await edit(h, (current) => ({
            state:
              !current.sealed && current.revision === latest.revision
                ? {
                    ...current,
                    sealed: true,
                    stopped:
                      current.stopped || now() >= current.handoff.deadline,
                  }
                : current,
            result: undefined,
          }))
        return project(h, await load(h))
      }),
    read: () =>
      backgroundEffect(async () => {
        const h = await open()
        return project(h, await load(h))
      }),
    stop: () =>
      backgroundEffect(async () => {
        const h = await open()
        const children = await edit(h, (state) =>
          state.sealed
            ? {
                state,
                result: [],
              }
            : {
                state: {
                  ...state,
                  stopped: true,
                  revision: state.revision + 1,
                },
                result: state.children,
              }
        )
        for (const child of children) await bridge.abort(child.id)
      }),
    control: (raw: Control) =>
      backgroundEffect(async () => {
        const input = Schema.decodeUnknownSync(Control)(raw),
          h = await open()
        const accepted = await edit(h, (state) => {
          if (
            input.groupId !== state.handoff.id ||
            !state.children.some((c) => c.id === input.childId)
          )
            throw fail("not_found", "Child unavailable in this group.")
          const previous = state.controls.find(
            (c) => c.operationId === input.operationId
          )
          if (previous) {
            if (JSON.stringify(previous) !== JSON.stringify(input))
              throw fail(
                "conflict",
                "This control ID belongs to another operation."
              )
            return { state, result: false }
          }
          if (
            state.sealed ||
            state.stopped ||
            now() >= state.handoff.deadline ||
            state.children.find((c) => c.id === input.childId)!.stopped
          )
            throw fail(
              "cancelled",
              "This background group has finished or stopped."
            )
          if (
            input.action.type === "steer" &&
            state.controls.filter(
              (c) => c.childId === input.childId && c.action.type === "steer"
            ).length >= 8
          )
            throw fail("limit", "This child reached its steering limit.")
          return {
            state: {
              ...state,
              revision: state.revision + 1,
              controls: [...state.controls, input],
              children: state.children.map((c) =>
                c.id === input.childId && input.action.type === "stop"
                  ? { ...c, stopped: true }
                  : c
              ),
            },
            result: true,
          }
        })
        await drain(h)
        return { accepted }
      }),
    request: (provider: string) =>
      backgroundEffect(async () => {
        const h = await open()
        await edit(h, (state) => {
          const child = state.children.find((c) => c.provider === provider)
          if (!child || child.stopped || state.stopped || state.sealed)
            throw fail("cancelled", "This background task has stopped.")
          if (
            now() >= state.handoff.deadline ||
            child.requests >= REQUEST_LIMIT
          )
            throw fail(
              "limit",
              "This background task reached its execution limit."
            )
          return {
            state: {
              ...state,
              revision: state.revision + 1,
              children: state.children.map((c) =>
                c.id === child.id ? { ...c, requests: c.requests + 1 } : c
              ),
            },
            result: undefined,
          }
        })
      }),
    transcript: (childId: number, cursor?: string) =>
      backgroundEffect(async () => {
        const h = await open(),
          state = await load(h)
        if (!state.children.some((c) => c.id === childId))
          throw fail("not_found", "Child unavailable in this group.")
        const before = cursor ? Number(cursor) : undefined
        if (
          before !== undefined &&
          (!Number.isSafeInteger(before) || before < 1)
        )
          throw fail("invalid", "Invalid transcript position.")
        const conversation = await h.conversation(
          childId as ConversationId,
          context
        )
        const page = await conversation!.entries(
          before ? { maxEntryId: before as EntryId } : {},
          20,
          undefined,
          context
        )
        return {
          entries: page.items.map((entry) => ({
            id: Number(entry.id),
            kind: entry.kind,
            text: trim(
              JSON.stringify(entry.model ?? entry.data ?? null, null, 2),
              16000
            ),
          })),
          cursor:
            page.next && page.items.length
              ? String(Number(page.items[page.items.length - 1]!.id) - 1)
              : null,
        }
      }),
  }
}
