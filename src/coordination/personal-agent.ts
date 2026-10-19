import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import type {
  ConversationId,
  Cursor,
  SubmissionRecord,
} from "@earendil-works/pi-durable"
import { Effect, Schema } from "effect"

import type { PersonalAgent } from "../agent/worker"
import { ConversationConflict, ConversationFull } from "../conversations/turns"
import { attributedText } from "../messages/identity"
import { preserveFatal } from "../shared/effect"
import { nativeOperation } from "../shared/interop"
import { CoordinationStore } from "./adapters/sqlite"
import {
  CoordinationFailure,
  fail,
  type Agent,
  type AgentReply,
} from "./contracts"
import { AgentCoordination, type CoordinationHost } from "./service"

type Work<T> = Effect.Effect<T, CoordinationFailure>
const boundary = <T, E>(work: Effect.Effect<T, E>): Work<T> =>
  work.pipe(
    Effect.mapError((cause) =>
      Schema.is(CoordinationFailure)(cause)
        ? cause
        : fail("unavailable", "Could not confirm agent coordination state.")
    )
  )
const native = <T>(body: (signal: AbortSignal) => Promise<T>) =>
  nativeOperation(body, () =>
    fail("unavailable", "Could not confirm native agent state.")
  )
export interface PersonalCoordination {
  store: CoordinationStore
  service: AgentCoordination
  rootLive: (id: string) => Work<boolean>
  stop: (id: string) => Work<void>
  beforeRequest: (nativeId: number) => Work<void>
  pump: () => Work<number | undefined>
}
const isSession = (origin: { kind: string } | undefined) =>
  !origin || origin.kind === "email" || origin.kind === "whatsapp"
export function personalCoordination(
  owner: PersonalAgent
): PersonalCoordination {
  const store = new CoordinationStore(owner.db)
  const enabled = () =>
    boundary(
      owner.botConfiguration
        .read()
        .pipe(Effect.map((config) => config?.status !== "archived"))
    )
  const rootLive = (id: string): Work<boolean> =>
    boundary(
      Effect.gen(function* () {
        const root = yield* owner.conversations.get(id)
        return (
          !!root &&
          !["failed", "cancelled", "stopping"].includes(root.status) &&
          !(yield* store.closed(id)) &&
          (yield* owner.routineAuthority.canRun(id)) &&
          (yield* enabled())
        )
      })
    )
  const agents = (id: string): Work<Agent[]> =>
    boundary(
      Effect.gen(function* () {
        const root = yield* owner.conversations.get(id)
        if (!root?.session_id || root.parent_id || !isSession(root.origin))
          return []
        const live = yield* rootLive(id),
          active = yield* owner.active()
        const values: Agent[] = [
          {
            address: { sessionId: id, agentId: "main" },
            name: "Main agent",
            role: "main",
            nativeId: Number(root.session_id),
            status: !live
              ? "stopped"
              : active?.session_id === root.session_id
                ? "working"
                : "idle",
          },
        ]
        const groupId = yield* owner.delegationLedger.parent(id)
        if (groupId) {
          const group = yield* owner.delegationLedger.group(groupId),
            view = yield* owner.delegations.read(groupId)
          for (const child of view.children)
            values.push({
              address: { sessionId: id, agentId: String(child.id) },
              name: child.name,
              role: "child",
              nativeId: child.id,
              deadline: group.deadline,
              status:
                !live ||
                group.closed ||
                group.deadline <= Date.now() ||
                group.children.find((c) => c.id === child.id)?.stopped ||
                ["cancelled", "failed", "stopping"].includes(child.status)
                  ? "stopped"
                  : child.status === "completed"
                    ? "idle"
                    : "working",
            })
        }
        return values
      })
    )
  const latest = (agent: Agent): Work<AgentReply | null> =>
    native(async (signal) => {
      const storage = await owner.harness.storage()
      let cursor: Cursor | undefined, answered: SubmissionRecord | undefined
      do {
        signal.throwIfAborted()
        const page = await storage.scanSubmissions(
          { conversationId: agent.nativeId as ConversationId, status: "done" },
          128,
          cursor,
          BACKGROUND_CONTEXT
        )
        for (const item of page.items)
          if (
            item.type === "input" &&
            item.status === "done" &&
            (!answered ||
              (answered.type === "input" &&
                answered.status === "done" &&
                item.answer > answered.answer))
          )
            answered = item
        cursor = page.next
      } while (cursor)
      if (answered?.type !== "input" || answered.status !== "done") return null
      const record = await storage.entry(
        agent.nativeId as ConversationId,
        answered.answer,
        BACKGROUND_CONTEXT
      )
      const messages =
        record?.entry.model?.filter((m) => m.role === "assistant") ?? []
      const text = messages
        .flatMap((m) =>
          m.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
        )
        .join("\n")
      return text
        ? {
            id: `entry:${answered.answer}`,
            text: text.slice(0, 8000),
            createdAt: messages.at(-1)?.timestamp ?? 0,
          }
        : null
    })
  const host: CoordinationHost = {
    bot: owner.messageProvenance({ kind: "service", id: "coordination" })
      .conversationId,
    enabled,
    agents,
    latest,
    source: (id) =>
      boundary(
        Effect.gen(function* () {
          const root = yield* owner.conversations.sessionForNative(id)
          if (root) return (yield* agents(root.id))[0]
          const groupId = yield* owner.delegationLedger.child(id)
          if (!groupId) return undefined
          const group = yield* owner.delegationLedger.group(groupId)
          return (yield* agents(group.turnId)).find(
            (agent) => agent.nativeId === id
          )
        })
      ),
    sessions: (before) =>
      boundary(
        Effect.gen(function* () {
          const turns = yield* owner.conversations.sessions(before)
          return yield* Effect.forEach(turns, (turn) =>
            rootLive(turn.id).pipe(
              Effect.map((live) => ({
                id: turn.id,
                title: turn.text.slice(0, 160),
                status: live
                  ? turn.status === "done"
                    ? "idle"
                    : "working"
                  : "stopped",
              }))
            )
          )
        })
      ),
    wake: () => native(() => owner.coordinationRunner.wake()),
    deliver: (message, target) => {
      if (target.role === "main")
        return boundary(
          store
            .atomic(() =>
              Effect.gen(function* () {
                if (
                  !(yield* rootLive(target.address.sessionId)) ||
                  !(yield* rootLive(message.from.sessionId))
                )
                  return yield* fail(
                    "closed",
                    "The addressed session has stopped."
                  )
                yield* owner.conversations.resumeMessage({
                  operationId: message.id,
                  text: message.text,
                  provenance: message.provenance,
                  origin: {
                    kind: "coordination",
                    turnId: target.address.sessionId,
                    messageId: message.id,
                    from: message.from,
                  },
                })
                yield* store.delivered(message.id)
              })
            )
            .pipe(
              Effect.mapError((cause) =>
                Schema.is(ConversationFull)(cause)
                  ? fail("busy", "The conversation queue is full.")
                  : Schema.is(ConversationConflict)(cause)
                    ? fail("closed", "The addressed session has stopped.")
                    : cause
              ),
              Effect.andThen(native(() => owner.runner.wake())),
              Effect.tap(() => Effect.sync(() => owner.notifyConversation()))
            )
        )
      return native(async (signal) => {
        const pi = await owner.harness.pi(),
          child = await pi.conversation(
            target.nativeId as ConversationId,
            BACKGROUND_CONTEXT
          )
        signal.throwIfAborted()
        if (!child)
          throw fail("closed", "The addressed agent no longer exists.")
        await child.submit(
          {
            type: "input",
            requestId: message.id,
            whenBusy: "steer",
            content: attributedText(
              JSON.stringify({
                messageId: message.id,
                from: message.from,
                text: message.text,
              }),
              message.provenance
            ),
          },
          BACKGROUND_CONTEXT
        )
      })
    },
  }
  const service = new AgentCoordination(store, host)
  const report = (child: Agent, turnId: string) =>
    Effect.gen(function* () {
      const reply = yield* latest(child)
      if (
        !reply ||
        (yield* store.operation(`result:${child.nativeId}:${reply.id}`))
      )
        return
      yield* service
        .send(child.nativeId, `result:${child.nativeId}:${reply.id}`, {
          to: { sessionId: turnId, agentId: "main" },
          text: reply.text,
        })
        .pipe(
          preserveFatal,
          Effect.catchTag("CoordinationFailure", (cause) =>
            ["closed", "limit"].includes(cause.code)
              ? Effect.void
              : Effect.fail(cause)
          )
        )
    })
  return {
    store,
    service,
    rootLive,
    stop: (id) =>
      boundary(
        Effect.gen(function* () {
          const turn = yield* owner.conversations.get(id)
          const root =
            turn?.origin?.kind === "coordination"
              ? turn.origin.turnId
              : (turn?.parent_id ?? id)
          yield* store.close(root)
        })
      ),
    beforeRequest: (nativeId) =>
      boundary(
        Effect.gen(function* () {
          const active = yield* owner.active()
          if (
            active?.origin?.kind === "coordination" &&
            active.session_id === String(nativeId)
          ) {
            if (!(yield* rootLive(active.origin.turnId)))
              return yield* fail("closed", "This session has stopped.")
            yield* store.request(active.id)
          }
        })
      ),
    pump: () =>
      boundary(
        Effect.gen(function* () {
          if ((yield* owner.active())?.origin?.kind === "coordination")
            yield* native(() => owner.runner.wake())
          let next: number | undefined
          for (const id of yield* owner.delegationLedger.catalog()) {
            const group = yield* owner.delegationLedger.group(id)
            if (!group.detached || group.closed) continue
            yield* owner.delegations.reconcile(group.turnId)
            if (
              group.deadline <= Date.now() ||
              !(yield* rootLive(group.turnId))
            )
              continue
            next = Math.min(next ?? Infinity, Date.now() + 1000, group.deadline)
            for (const child of (yield* agents(group.turnId)).filter(
              (agent) => agent.role === "child" && agent.status !== "stopped"
            ))
              yield* report(child, group.turnId)
          }
          const messages = yield* service.pump()
          return messages === undefined
            ? next
            : Math.min(next ?? Infinity, messages)
        })
      ),
  }
}
