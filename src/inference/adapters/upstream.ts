import { createEffectActor, waitFor } from "@xstate/effect"
import { Deferred, Effect, Exit, Queue, Schema, Scope } from "effect"

import { fatalCause, orDieAll } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"
import { joinUpstreamCleanup } from "../upstream-cleanup"
import { upstreamPumpMachine } from "../upstream.machine"

export interface UpstreamCorrelation {
  turnId: string
  attemptId: string
}

export interface UpstreamObservationPeer {
  observeUpstream(
    id: string,
    sink: WritableStream<Uint8Array>
  ): Promise<boolean>
  releaseUpstream(id: string): Promise<void>
}

/** Workerd rejects an outstanding native read after its owner cancels it.
 * Only this raw platform acknowledgement is expected; an Effect Cause, even
 * one containing an AbortError, must retain every checked/defect reason. */
export const upstreamNativeCancellation = (cause: unknown) =>
  (cause instanceof Error || cause instanceof DOMException) &&
  (cause.name === "AbortError" || cause.message === "Stream was cancelled.")

/** Inspect bounded SSE lines without retaining or reporting provider content. */
export const upstreamTextDetector = Effect.sync(() => {
  const decoder = new TextDecoder()
  let line = ""
  let discarded = false
  let found = false
  return (bytes: Uint8Array) => {
    if (found) return false
    const text = decoder.decode(bytes, { stream: true })
    let start = 0
    for (;;) {
      const end = text.indexOf("\n", start)
      const part = text.slice(start, end < 0 ? undefined : end)
      if (!discarded) {
        if (line.length + part.length > 16_384) {
          line = ""
          discarded = true
        } else line += part
      }
      if (end < 0) return false
      if (!discarded && line.startsWith("data: ")) {
        try {
          const event: unknown = JSON.parse(line.slice(6))
          if (
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "response.output_text.delta" &&
            "delta" in event &&
            typeof event.delta === "string" &&
            event.delta.length > 0
          ) {
            found = true
            return true
          }
        } catch {}
      }
      line = ""
      discarded = false
      start = end + 1
    }
  }
})

/** A bounded copy keeps the upstream reader in the relay's I/O context.
 * Exporting a native tee branch instead couples observation to actor reads.
 * At most four 16 KiB slices plus one <=1 MiB transport chunk are retained. */
export const upstreamResponse = Effect.fn("Inference.upstreamResponse")(
  function* (
    response: Response,
    ready: Deferred.Deferred<Response>,
    mark: (stage: string) => void
  ) {
    if (!response.body) {
      yield* Deferred.succeed(ready, response)
      return
    }
    const queue = yield* Queue.bounded<Uint8Array | null>(4)
    const detector = yield* upstreamTextDetector
    const reader = response.body.getReader()
    const body = new ReadableStream<Uint8Array>({
      type: "bytes",
      async pull(controller) {
        const next = await Effect.runPromiseExit(Queue.take(queue))
        if (Exit.isFailure(next)) controller.error(next.cause)
        else if (next.value === null) controller.close()
        else controller.enqueue(next.value.slice())
      },
      cancel: () => Effect.runPromise(Queue.shutdown(queue)).then(() => {}),
    })
    yield* Deferred.succeed(ready, new Response(body, response))
    const scope = yield* Scope.make()
    let reading: Promise<ReadableStreamReadResult<Uint8Array>> | undefined
    const actor = yield* createEffectActor(
      upstreamPumpMachine({
        read: Effect.promise(() => (reading = reader.read())),
        write: (chunk) =>
          Effect.gen(function* () {
            const bytes = Schema.decodeUnknownSync(Schema.Uint8Array)(chunk)
            if (bytes.byteLength > 1024 * 1024)
              return yield* Effect.die(
                new Error("Upstream chunk exceeds probe bound")
              )
            if (detector(bytes)) mark("upstream-text")
            for (let offset = 0; offset < bytes.length; offset += 16_384) {
              const accepted = yield* Queue.offer(
                queue,
                bytes.slice(offset, offset + 16_384)
              )
              if (!accepted) return false
            }
            return true
          }),
        end: Queue.offer(queue, null),
        close: nativeOperation(
          async () => {
            const cancelled = reader.cancel()
            await joinUpstreamCleanup(
              [
                cancelled.catch((cause: unknown) => {
                  if (!upstreamNativeCancellation(cause)) throw cause
                }),
                reading?.catch((cause: unknown) => {
                  if (!upstreamNativeCancellation(cause)) throw cause
                }) ?? Promise.resolve(),
              ],
              [() => reader.releaseLock()]
            )
          },
          (cause) => cause
        ),
      })
    ).pipe(Effect.provideService(Scope.Scope, scope))
    const done = waitFor(actor, (state) => state.status === "done").pipe(
      Effect.orDie,
      Effect.flatMap((state) => state.output!)
    )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (actor.getSnapshot().status !== "done") actor.send({ type: "CLOSE" })
        yield* done
      }).pipe(Effect.ensuring(Scope.close(scope, Exit.void)), orDieAll)
    )
    yield* done.pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Queue.failCause(queue, fatalCause(exit.cause)).pipe(Effect.asVoid)
          : Effect.void
      )
    )
  }
)
