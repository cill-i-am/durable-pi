import { Deferred, Effect, Queue } from "effect"

import type { ConversationLatency, HandoffMilestone } from "../latency"
import type { ConversationEventRunner } from "./events"

/** Authenticated native byte pipe, independent of the JS chat-body pump.
 * Compare IDs on the browser's monotonic clock. Native output gates still
 * apply: co-arrival cannot exclude a shared gate. No message text or clocks.
 * Consumer cancellation signals scope cleanup; unlike the ordinary chat body,
 * native cancel itself does not join that cleanup. waitUntil owns the task. */
export const clocklessHandoff = Effect.fn("Conversations.clocklessHandoff")(
  function* (
    latency: ConversationLatency,
    confirmation: Effect.Effect<void>,
    signal: AbortSignal,
    run: ConversationEventRunner,
    own: (task: Promise<void>) => void
  ) {
    const pipe = new IdentityTransformStream()
    const writer = pipe.writable.getWriter()
    const ended = yield* Deferred.make<void>()
    const started = yield* Deferred.make<boolean>()
    const confirmations = yield* Queue.bounded<HandoffMilestone>(8)
    const encoder = new TextEncoder()
    const cancelled = new AbortController()
    let closed = false
    let pending = 0
    let transferred = false
    const finish = () => Deferred.doneUnsafe(ended, Effect.void)
    const write = (event: object) => {
      if (closed) return
      if (pending >= 16) {
        closed = true
        finish()
        return
      }
      pending++
      void writer
        .write(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        .then(
          () => {
            pending--
          },
          () => {
            pending--
            finish()
          }
        )
    }
    void writer.closed.then(finish, finish)
    const program = Effect.gen(function* () {
      const unsubscribe = yield* Effect.acquireRelease(
        Effect.sync(() =>
          latency.observe((event) => {
            write(event)
            if (
              event.stage === "enqueued" &&
              !Queue.offerUnsafe(confirmations, event)
            )
              finish()
          })
        ),
        (release) =>
          Effect.sync(() => {
            closed = true
            release?.()
          })
      )
      yield* Deferred.succeed(started, Boolean(unsubscribe))
      if (!unsubscribe) return
      // Positive control for the receiving clock/transport, completed before
      // the caller starts a chat. This is never added to ordinary chat streams.
      write({ stage: "control-start" })
      yield* Effect.sleep(250)
      write({ stage: "ready" })
      // A native idle pipe reports disconnection on its next write. Bound
      // observer retention after a disconnect without wrapping the byte body
      // in a JS ReadableStream (the path this experiment is measuring).
      yield* Effect.forever(
        Effect.sleep(1000).pipe(
          Effect.andThen(Effect.sync(() => write({ stage: "heartbeat" })))
        )
      ).pipe(Effect.forkScoped)
      const confirm = Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(confirmations)
          yield* Effect.sleep(0)
          write({ ...event, stage: "yielded" })
          yield* confirmation
          write({ ...event, stage: "confirmed" })
        })
      )
      yield* Effect.raceFirst(confirm, Deferred.await(ended))
    }).pipe(
      Effect.raceFirst(Effect.sleep(60_000)),
      Effect.scoped,
      Effect.ensuring(
        Effect.promise(async () => {
          if (!pipe.readable.locked)
            await pipe.readable.cancel().catch(() => {})
          await writer.abort().catch(() => {})
        })
      )
    )
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        run(program, { signal: AbortSignal.any([signal, cancelled.signal]) })
      ),
      (task) =>
        Effect.gen(function* () {
          own(task.then(() => {}))
          const admitted = yield* Effect.raceFirst(
            Deferred.await(started),
            Effect.promise(() => task).pipe(Effect.as(false))
          )
          if (!admitted)
            return new Response("Diagnostic unavailable", { status: 429 })
          const response = new Response(pipe.readable, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "private, no-store",
              "X-Accel-Buffering": "no",
            },
          })
          transferred = true
          return response
        }),
      (task) =>
        transferred
          ? Effect.void
          : Effect.gen(function* () {
              cancelled.abort()
              yield* Effect.promise(() => task)
            })
    )
  }
)
