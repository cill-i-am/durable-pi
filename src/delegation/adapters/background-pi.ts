import type { Context } from "@earendil-works/chord"
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
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
import { Effect, Schema } from "effect"

import {
  BackgroundState,
  backgroundChildInstructions,
  backgroundInitialId,
  backgroundControlId,
  restoreBackgroundState,
  migrateBackgroundState,
  trimBackgroundText,
} from "../background-task-domain"
import type { BackgroundTaskLedger } from "../background-task-ledger"
import { delegationCommit, delegationNative, backgroundNative } from "./interop"

export const BackgroundDocument = defineDoc({
  kind: "delegation.background",
  version: 2,
  migrate: (raw, version) => {
    if (version !== 1 || typeof raw.value !== "string")
      throw new Error(
        "Unsupported background document version; retain the document and restore a compatible release."
      )
    return {
      value: raw.value
        ? JSON.stringify(migrateBackgroundState(JSON.parse(raw.value)))
        : "",
    }
  },
  scope: "session",
  initial: () => ({ value: "" }),
})
const JsonState = Schema.fromJsonString(BackgroundState)
const decode = (value: string) =>
  restoreBackgroundState(Schema.decodeUnknownSync(JsonState)(value))
export async function readBackgroundHandoff(
  h: Harness,
  context: Context = BACKGROUND_CONTEXT
) {
  const document = await h.snapshot(BackgroundDocument, context)
  return document?.value ? decode(document.value).handoff : undefined
}
const stateView = (document: { value: string }) => {
  let value = document.value ? decode(document.value) : null
  return {
    get value() {
      return value
    },
    set value(next: BackgroundState | null) {
      if (
        value &&
        (!next ||
          JSON.stringify(value.handoff) !== JSON.stringify(next.handoff) ||
          JSON.stringify(
            value.children.map(({ id, provider }) => ({ id, provider }))
          ) !==
            JSON.stringify(
              next.children.map(({ id, provider }) => ({ id, provider }))
            ))
      )
        throw new Error(
          "Background update changed its handoff or child identity."
        )
      if (next) restoreBackgroundState(next)
      document.value = next ? Schema.encodeSync(JsonState)(next) : ""
      value = next
    },
  }
}
const Facts = Schema.Struct({
  inputs: Schema.Array(
    Schema.UndefinedOr(
      Schema.Struct({
        status: Schema.Literals(["queued", "placed", "done", "unanswered"]),
      })
    )
  ),
  answer: Schema.String,
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
})
export function piBackgroundLedger(
  open: () => Promise<Harness>,
  bridge: {
    submit: (
      child: number,
      text: string,
      operationId: string,
      steer: boolean
    ) => Promise<unknown>
    abort: (child: number) => Promise<unknown>
  }
): BackgroundTaskLedger {
  const snapshot = <T>(body: (h: Harness, context: Context) => Promise<T>) =>
    delegationNative(open).pipe(
      Effect.flatMap((h) => delegationNative((context) => body(h, context)))
    )
  const submission = (h: Harness, child: number, request: string) =>
    delegationNative((context) =>
      h.commit(
        (tx) => tx.submissionByRequest(child as ConversationId, request),
        context
      )
    )
  return {
    atomic: (body) =>
      delegationNative(open).pipe(
        Effect.flatMap((h) =>
          delegationCommit(h, (tx) =>
            body({
              state: () =>
                delegationNative(() => tx.doc(BackgroundDocument)).pipe(
                  Effect.map(stateView)
                ),
              createChild: (handoff, task) =>
                Effect.gen(function* () {
                  const child = yield* delegationNative(() =>
                    tx.createConversation({ ownership: { kind: "ownerless" } })
                  )
                  yield* delegationNative(() =>
                    configure(tx, child.id, {
                      model: {
                        provider: "openai",
                        modelId: handoff.route.model,
                      },
                      thinkingLevel: handoff.route.thinking,
                      extensions: [],
                      tools: [],
                      instructions: backgroundChildInstructions(handoff, task),
                    })
                  )
                  const provider = yield* delegationNative(() =>
                    tx.doc(ProviderDoc, child.id)
                  )
                  return {
                    id: Number(child.id),
                    provider: provider.sessionId,
                  }
                }),
            })
          )
        )
      ),
    state: () =>
      snapshot(async (h, context) => {
        if (!(await h.snapshot(BackgroundDocument, context))) return undefined
        // Acquiring an existing v1 document commits its migrated base. Copy the
        // value inside the native callback; an overlay cannot escape its commit.
        return h.commit(
          async (tx) => ({ value: (await tx.doc(BackgroundDocument)).value }),
          context
        )
      }).pipe(
        Effect.map((document) =>
          document?.value ? decode(document.value) : undefined
        )
      ),
    facts: (state) =>
      delegationNative(open).pipe(
        Effect.flatMap((h) =>
          Effect.forEach(
            state.children,
            (child) =>
              Effect.gen(function* () {
                const records = []
                for (const id of [
                  backgroundInitialId(child.id),
                  ...state.controls
                    .filter(
                      (control) =>
                        control.childId === child.id &&
                        control.action.type === "steer"
                    )
                    .map(backgroundControlId),
                ])
                  records.push(yield* submission(h, child.id, id))
                const answer = records
                  .filter(
                    (record) =>
                      record?.type === "input" && record.status === "done"
                  )
                  .sort((a, b) => b.answer - a.answer)[0]
                const entry = answer
                  ? yield* delegationNative((context) =>
                      h.commit(
                        (tx) => tx.entry(AssistantEntry, answer.answer),
                        context
                      )
                    )
                  : undefined
                const text = (entry?.model ?? [])
                  .flatMap((message) =>
                    Array.isArray(message.content)
                      ? message.content
                          .filter((part) => part.type === "text")
                          .map((part) => part.text)
                      : []
                  )
                  .join("\n")
                const usage = yield* delegationNative((context) =>
                    h.snapshot(UsageDoc, child.id as ConversationId, context)
                  ),
                  totals = Object.values(usage?.models ?? {})
                return Schema.decodeUnknownSync(Facts)({
                  inputs: records.map((record) =>
                    record
                      ? Schema.decodeUnknownSync(
                          Schema.Struct({ status: Schema.String })
                        )(record)
                      : undefined
                  ),
                  answer: text,
                  inputTokens: totals.length
                    ? totals.reduce(
                        (n, u) => n + u.input + u.cacheRead + u.cacheWrite,
                        0
                      )
                    : null,
                  outputTokens: totals.length
                    ? totals.reduce((n, u) => n + u.output, 0)
                    : null,
                })
              }),
            { concurrency: 3 }
          )
        )
      ),
    hasSubmission: (child, request) =>
      delegationNative(open).pipe(
        Effect.flatMap((h) => submission(h, child, request)),
        Effect.map((record) => record !== undefined)
      ),
    submit: (child, text, request, steer) =>
      backgroundNative(() => bridge.submit(child, text, request, steer)).pipe(
        Effect.asVoid
      ),
    abort: (child) =>
      backgroundNative(() => bridge.abort(child)).pipe(Effect.asVoid),
    transcript: (child, before) =>
      snapshot((h, context) =>
        h.conversation(child as ConversationId, context)
      ).pipe(
        Effect.flatMap((conversation) =>
          conversation
            ? delegationNative((context) =>
                conversation.entries(
                  before ? { maxEntryId: before as EntryId } : {},
                  20,
                  undefined,
                  context
                )
              )
            : Effect.die(
                new Error(
                  "Stored background child conversation is unavailable."
                )
              )
        ),
        Effect.map((page) => ({
          entries: page.items.map((entry) => ({
            id: Number(entry.id),
            kind: entry.kind,
            text: trimBackgroundText(
              JSON.stringify(entry.model ?? entry.data ?? null, null, 2),
              16000
            ),
          })),
          cursor:
            page.next && page.items.length
              ? String(Number(page.items[page.items.length - 1]!.id) - 1)
              : null,
        }))
      ),
  }
}
