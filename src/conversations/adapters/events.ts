import type { AgentEventStream } from "@earendil-works/pi-durable"
import type { StreamChunk } from "@tanstack/ai/client"
import { Cause, Effect, Exit, Schema } from "effect"

import { orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import {
  ConversationCursor,
  type ChatState,
  type ConversationFrame,
} from "../contracts"
import { conversationEventPump } from "../events"
import { chatMessages, messageEvents } from "./tanstack"

export class ConversationStreamError extends Schema.TaggedError<ConversationStreamError>()(
  "ConversationStreamError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}
const streamNative = <T>(operation: string, start: () => Promise<T>) =>
  nativeOperation(start, (cause, channel) => {
    const expected = Schema.decodeUnknownOption(ConversationStreamError)(cause)
    if (expected._tag === "Some") return expected.value
    if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
    return new ConversationStreamError({ operation, cause })
  })
export type ConversationEventRunner = <TValue, TError>(
  program: Effect.Effect<TValue, TError>,
  options: { signal: AbortSignal }
) => Promise<Exit.Exit<TValue, unknown>>
type Source<TError> = {
  snapshot: () => Effect.Effect<ChatState, TError>
  activeSession: () => Effect.Effect<string | undefined, TError>
  watch: (id: string) => Promise<AgentEventStream>
  subscribe: (listener: () => void) => () => void
}

/** One bounded, volatile checkpoint per native agent instance. A restart or
 * any state change falls back to a complete snapshot; no second journal. */
export class ConversationCheckpoint {
  private previous: string | undefined
  private revision: ConversationCursor | undefined
  current(state: ChatState): ConversationCursor {
    const serialized = JSON.stringify(state)
    if (serialized !== this.previous) {
      this.previous = serialized
      this.revision = Schema.decodeUnknownSync(ConversationCursor)(
        crypto.randomUUID()
      )
    }
    return this.revision!
  }
}

function frames(
  state: ChatState,
  previous: ChatState | undefined,
  tanstack: boolean
): readonly (ConversationFrame | StreamChunk)[] {
  const { turns: _turns, ...meta } = state
  const { turns: _previous, ...oldMeta } = previous ?? {}
  if (tanstack) {
    const events: StreamChunk[] = messageEvents(
      previous ? chatMessages(previous.turns) : undefined,
      chatMessages(state.turns)
    )
    if (!previous || JSON.stringify(meta) !== JSON.stringify(oldMeta))
      events.push({ type: "CUSTOM", name: "durable-pi.metadata", value: meta })
    return events
  }
  if (!previous) return [{ type: "snapshot", state }]
  const before = new Map(
    previous.turns.map((turn) => [turn.id, JSON.stringify(turn)])
  )
  const turns = state.turns.filter(
    (turn) => before.get(turn.id) !== JSON.stringify(turn)
  )
  const changedMeta = JSON.stringify(meta) !== JSON.stringify(oldMeta)
  return turns.length ||
    changedMeta ||
    state.turns.length !== previous.turns.length
    ? [
        {
          type: "update",
          turns,
          ids: state.turns.map((turn) => turn.id),
          ...(changedMeta ? { meta } : {}),
        },
      ]
    : []
}

/** Native body consumption owns the scoped program. Its cancel Promise joins
 * pending acquisition, refresh and release; the Response does not close them. */
export function conversationEvents<TError>(
  source: Source<TError>,
  signal: AbortSignal,
  tanstack = false,
  run: ConversationEventRunner = Effect.runPromiseExit,
  resume?: { checkpoint: ConversationCheckpoint; after: string | null }
): Response {
  const encoder = new TextEncoder()
  const cancelled = new AbortController()
  let consumerClosed = false
  let task: Promise<Exit.Exit<void, unknown>> | undefined
  let sentRevision: string | undefined
  const decodedCursor = Schema.decodeUnknownOption(ConversationCursor)(
    resume?.after
  )
  const acknowledged =
    decodedCursor._tag === "Some" ? decodedCursor.value : undefined
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const send = (value: string) => {
          if (consumerClosed || (controller.desiredSize ?? 0) <= 0) return false
          controller.enqueue(encoder.encode(value))
          return true
        }
        const program = Effect.scoped(
          conversationEventPump<TError | ConversationStreamError, never>(
            {
              snapshot: source.snapshot,
              activeSession: source.activeSession,
              subscribe: (notify) =>
                Effect.acquireRelease(
                  Effect.sync(() => source.subscribe(notify)),
                  (unsubscribe) => Effect.sync(unsubscribe)
                ).pipe(Effect.asVoid),
              watch: (id, notify) =>
                Effect.acquireRelease(
                  streamNative("watch", () => source.watch(id)),
                  (watch) =>
                    streamNative("stop watch", () => watch.stop()).pipe(
                      orDieAll
                    )
                ).pipe(
                  Effect.flatMap((watch) =>
                    Effect.sync(() => watch.start(async () => notify()))
                  )
                ),
            },
            {
              publish: (state, previous) => {
                let revision =
                  tanstack && !previous
                    ? resume?.checkpoint.current(state)
                    : undefined
                const output =
                  !previous && revision && revision === acknowledged
                    ? []
                    : frames(state, previous, tanstack)
                // Unchanged heartbeats keep their existing reconciliation work
                // without adding another full-state serialization for a cursor.
                if (previous && output.length && tanstack)
                  revision = resume?.checkpoint.current(state)
                for (const frame of output)
                  if (!send(`data: ${JSON.stringify(frame)}\n\n`)) return false
                // Advance the client only after every preceding frame has been
                // delivered. A lost tail therefore causes a safe full resync.
                if (revision && revision !== sentRevision) {
                  if (
                    !send(
                      `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.cursor", value: revision })}\n\n`
                    )
                  )
                    return false
                  sentRevision = revision
                }
                return !consumerClosed
              },
              heartbeat: () => send(": keepalive\n\n"),
            }
          )()
        ).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
              ? Effect.void
              : Cause.hasDies(exit.cause)
                ? Effect.logError("Conversation.streamFailed")
                : Effect.logWarning("Conversation.streamUnavailable")
          )
        )
        task = run(program, {
          signal: AbortSignal.any([signal, cancelled.signal]),
        })
        void task.then(() => {
          if (!consumerClosed) {
            consumerClosed = true
            controller.close()
          }
        })
      },
      async cancel() {
        consumerClosed = true
        cancelled.abort()
        const exit = await task
        if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause))
          throw new Error("Conversation stream cleanup failed.")
      },
    },
    { highWaterMark: 4 }
  )
  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  })
}
