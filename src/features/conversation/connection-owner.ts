import { EventType, type StreamChunk } from "@tanstack/ai"
import {
  createEffectActor,
  EffectFailure,
  type EffectActor,
} from "@xstate/effect"
import {
  Cause,
  Deferred,
  Effect,
  Equal,
  Exit,
  Queue,
  Schema,
  Scope,
} from "effect"

import { ConversationCursor } from "@/conversations/contracts"
import { ApiError } from "@/http/client"
import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

import {
  ConnectionChunk,
  ConversationConnectionFailure,
  conversationConnectionMachine,
} from "./connection.machine"

const connectionNotice = (value: string): StreamChunk => ({
  type: "CUSTOM",
  name: "durable-pi.connection",
  value,
})
function failed(error: unknown) {
  const value =
    error instanceof Error && error.cause instanceof ApiError
      ? error.cause
      : error
  return new ConversationConnectionFailure({
    error: value,
    terminal: value instanceof ApiError,
  })
}
function cursor(chunk: StreamChunk): ConversationCursor | null {
  if (chunk.type !== "CUSTOM" || chunk.name !== "durable-pi.cursor") return null
  const value = Schema.decodeUnknownOption(ConversationCursor)(chunk.value)
  return value._tag === "Some" ? value.value : null
}

/** One consumer scope owns the native iterator, abort listener and bounded queue.
 * Read cancellation joins native settlement before the subscription returns. */
export function makeConversationConnection(
  stream: (
    cursor: ConversationCursor | null,
    signal: AbortSignal
  ) => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
  mark: (name: "snapshot") => void = () => {}
) {
  return Effect.gen(function* () {
    const queue = yield* Queue.bounded<StreamChunk, unknown>(1)
    let actor:
      | EffectActor<ReturnType<typeof conversationConnectionMachine>>
      | undefined
    let cleanup: Cause.Cause<ConversationConnectionFailure> | undefined
    let observedFailure: unknown
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const retained = observedFailure
        const reasons = Cause.isCause(retained) ? retained.reasons : []
        const missing =
          cleanup?.reasons.filter(
            (reason) =>
              !reasons.some((present) => Equal.equals(present, reason))
          ) ?? []
        return cleanup &&
          (Cause.hasDies(cleanup) ||
            (Cause.hasInterrupts(cleanup) &&
              !Cause.hasInterruptsOnly(cleanup))) &&
          missing.length
          ? Effect.failCause(Cause.fromReasons(missing)).pipe(orDieAll)
          : Effect.void
      })
    )
    yield* Effect.addFinalizer(() => Queue.shutdown(queue))
    actor = yield* createEffectActor(
      conversationConnectionMachine({
        read: (after, attempt) =>
          nativeOperation(async (owned) => {
            const aborted = signal ? AbortSignal.any([owned, signal]) : owned
            if (aborted.aborted) return
            for await (const raw of stream(after, aborted)) {
              if (aborted.aborted) return
              const chunk = Schema.decodeUnknownSync(ConnectionChunk)(raw)
              const reply = Deferred.makeUnsafe<void>()
              actor!.send({
                type: "FRAME",
                chunk,
                cursor: cursor(chunk),
                attempt,
                reply,
              })
              await Effect.runPromise(Deferred.await(reply), {
                signal: aborted,
              })
            }
          }, failed).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                cleanup = Exit.isFailure(exit) ? exit.cause : undefined
              })
            )
          ),
        publish: (chunk, first, reply) =>
          Effect.gen(function* () {
            if (chunk.type === EventType.MESSAGES_SNAPSHOT) mark("snapshot")
            if (first) yield* Queue.offer(queue, connectionNotice(""))
            yield* Queue.offer(queue, chunk)
            yield* Deferred.succeed(reply, undefined)
          }),
        interrupted: Queue.offer(
          queue,
          connectionNotice("Connection interrupted. Reconnecting…")
        ).pipe(Effect.asVoid),
        finish: (error) =>
          (error === null ? Queue.end(queue) : Queue.fail(queue, error)).pipe(
            Effect.asVoid
          ),
      })
    )
    const owned = actor
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        owned.subscribe({
          error: (cause) => {
            Queue.failCauseUnsafe(
              queue,
              EffectFailure.is(cause)
                ? cause.cause
                : Cause.isCause(cause)
                  ? cause
                  : Cause.die(cause)
            )
          },
        })
      ),
      (subscription) => Effect.sync(() => subscription.unsubscribe())
    )
    const abort = () => owned.send({ type: "STOP" })
    if (signal) {
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          signal.addEventListener("abort", abort, { once: true })
          if (signal.aborted) abort()
        }),
        () => Effect.sync(() => signal.removeEventListener("abort", abort))
      )
    }
    return {
      actor: owned,
      queue,
      observeFailure: (cause: unknown) => {
        observedFailure = cause
      },
    }
  })
}

export async function* subscribeConversation(
  stream: (
    cursor: ConversationCursor | null,
    signal: AbortSignal
  ) => AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
  mark?: (name: "snapshot") => void
): AsyncGenerator<StreamChunk> {
  if (signal?.aborted) return
  const scope = Scope.makeUnsafe()
  let primary: unknown
  try {
    const { queue, observeFailure } = await Effect.runPromise(
      makeConversationConnection(stream, signal, mark).pipe(
        Effect.provideService(Scope.Scope, scope)
      )
    )
    for (;;) {
      const next = await Effect.runPromiseExit(Queue.take(queue))
      if (Exit.isFailure(next)) {
        if (
          signal?.aborted ||
          next.cause.reasons.every(
            (reason) => reason._tag === "Fail" && Cause.isDone(reason.error)
          )
        )
          return
        const reason = next.cause.reasons[0]
        const error =
          next.cause.reasons.length === 1 && reason?._tag === "Fail"
            ? reason.error
            : next.cause
        observeFailure(error)
        throw error
      }
      if (signal?.aborted) return
      yield next.value
    }
  } catch (cause) {
    primary = cause
    throw cause
  } finally {
    await closeConnection(scope, primary)
  }
}
async function closeConnection(scope: Scope.Closeable, primary: unknown) {
  const closed = await Effect.runPromiseExit(Scope.close(scope, Exit.void))
  if (Exit.isFailure(closed))
    throw primary === undefined
      ? closed.cause
      : Cause.combine(
          Cause.isCause(primary) ? primary : Cause.die(primary),
          closed.cause
        )
}
