import type { AgentEvent, AgentEventStream } from "@earendil-works/pi-durable"
import type { StreamChunk } from "@tanstack/ai/client"
import { Cause, Clock, Effect, Exit, Schema } from "effect"

import { orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import {
  ConversationCursor,
  type ChatState,
  type ConversationFrame,
} from "../contracts"
import { conversationEventPump } from "../events"
import { probeHandoff, type HandoffPublication } from "../handoff"
import type { ConversationLatency, FirstTextTrace } from "../latency"
import { conversationOutput } from "./output"
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
  latency?: ConversationLatency
  confirmation?: Effect.Effect<void>
  paddingBytes?: 4096 | 16384
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
  const cancelled = new AbortController()
  let consumerClosed = false
  let task: Promise<Exit.Exit<void, unknown>> | undefined
  let sentRevision: string | undefined
  let snapshotStartedAt = 0
  let snapshotReadyAt = 0
  const streamId = crypto.randomUUID()
  const openedAt = source.confirmation
    ? Effect.runSync(Clock.currentTimeMillis)
    : undefined
  let publications: HandoffPublication[] = []
  let pullCount = 0
  let lastPullAt: number | undefined
  let demand = () => {}
  const noteEnqueued = (traces: readonly FirstTextTrace[]) => {
    if (source.latency)
      for (const trace of traces)
        Effect.runSync(
          source.latency.enqueued(trace.turnId, trace.attemptId, streamId)
        )
  }
  const decodedCursor = Schema.decodeUnknownOption(ConversationCursor)(
    resume?.after
  )
  const acknowledged =
    decodedCursor._tag === "Some" ? decodedCursor.value : undefined
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const queue = conversationOutput(controller, () => consumerClosed)
        demand = queue.pull
        const program = Effect.scoped(
          conversationEventPump<TError | ConversationStreamError, never>(
            {
              snapshot: () =>
                Effect.gen(function* () {
                  snapshotStartedAt = yield* Clock.currentTimeMillis
                  const state = yield* source.snapshot()
                  snapshotReadyAt = yield* Clock.currentTimeMillis
                  return state
                }),
              beforePublish: (state, previous) =>
                (source.latency && source.confirmation && previous
                  ? source.latency.confirm(
                      state.turns
                        .filter(
                          (turn) =>
                            turn.answer &&
                            !previous.turns.find(
                              (before) => before.id === turn.id
                            )?.answer
                        )
                        .map((turn) => turn.id),
                      source.confirmation
                    )
                  : Effect.void
                ).pipe(
                  Effect.andThen(queue.reserve),
                  Effect.annotateLogs({ turnId: state.turns.at(-1)?.id })
                ),
              afterPublish: source.confirmation
                ? Effect.suspend(() => {
                    const pending = publications
                    publications = []
                    return Effect.forEach(
                      pending,
                      (publication) =>
                        probeHandoff(publication, source.confirmation!, () => ({
                          desiredSize: controller.desiredSize,
                          pullCount,
                          lastPullAt,
                        })).pipe(Effect.forkScoped),
                      { discard: true }
                    )
                  })
                : undefined,
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
                    Effect.sync(() => {
                      if (source.latency && hasNativeText(watch.snapshot))
                        Effect.runSync(source.latency.native(id))
                      watch.start(async (events) => {
                        if (source.latency && events.some(hasNativeText))
                          Effect.runSync(source.latency.native(id))
                        notify()
                      })
                    })
                  )
                ),
            },
            {
              publish: (state, previous) => {
                try {
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
                  const firstText = tanstack
                    ? firstTextDiagnostic(
                        source.latency,
                        state,
                        previous,
                        snapshotStartedAt,
                        snapshotReadyAt,
                        streamId,
                        source.confirmation ? source.paddingBytes : undefined
                      )
                    : { data: "", traces: [] }
                  let batch =
                    firstText.data +
                    output
                      .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
                      .join("")
                  // Advance the client only after every preceding frame has been
                  // delivered. A lost tail therefore causes a safe full resync.
                  if (revision && revision !== sentRevision) {
                    batch += `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.cursor", value: revision })}\n\n`
                  }
                  if (batch && !queue.enqueue(batch)) return false
                  noteEnqueued(firstText.traces)
                  if (revision) sentRevision = revision
                  if (source.confirmation)
                    publications = firstText.traces.map((trace) => ({
                      turnId: trace.turnId,
                      attemptId: trace.attemptId,
                      streamId,
                      publishedAt: trace.publishedAt!,
                      enqueuedAt: Effect.runSync(Clock.currentTimeMillis),
                      queue: {
                        desiredSize: controller.desiredSize,
                        pullCount,
                        lastPullAt,
                      },
                    }))
                  return !consumerClosed
                } finally {
                  queue.release()
                }
              },
              heartbeat: queue.heartbeat,
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
      pull() {
        demand()
        if (source.confirmation) {
          pullCount++
          lastPullAt = Effect.runSync(Clock.currentTimeMillis)
        }
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
      "Cache-Control": "private, no-store",
      "X-Accel-Buffering": "no",
      ...(openedAt !== undefined
        ? { "X-Durable-Pi-Stream-Opened-At": String(openedAt) }
        : {}),
    },
  })
}

function firstTextDiagnostic(
  latency: ConversationLatency | undefined,
  state: ChatState,
  previous: ChatState | undefined,
  started: number,
  ready: number,
  streamId?: string,
  paddingBytes?: 4096 | 16384
) {
  const traces: FirstTextTrace[] = []
  if (!latency || !previous) return { data: "", traces }
  let diagnostic = ""
  for (const turn of state.turns) {
    const before = previous.turns.find((candidate) => candidate.id === turn.id)
    if (!turn.answer || before?.answer) continue
    const trace = Effect.runSync(latency.publication(turn.id, started, ready))
    if (trace) {
      traces.push(trace)
      diagnostic += `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.first-text", value: { ...trace, ...(streamId ? { streamId } : {}) } })}\n\n`
    }
  }
  return {
    data:
      streamId && paddingBytes && diagnostic
        ? `:${" ".repeat(paddingBytes - 3)}\n\n${diagnostic}`
        : diagnostic,
    traces,
  }
}

function hasNativeText(event: AgentEvent): boolean {
  const text = (content: readonly { type: string; text?: string }[]) =>
    content.some((block) => block.type === "text" && Boolean(block.text))
  if (event.type === "message_start")
    return event.message.role === "assistant" && text(event.message.content)
  if (event.type === "snapshot")
    return text(event.generation?.message?.content ?? [])
  if (event.type !== "message_update") return false
  return event.changes.some((change) => {
    if (change.type === "text_delta") return change.delta.length > 0
    if (change.type === "message") return text(change.message.content)
    return "block" in change && text([change.block])
  })
}
