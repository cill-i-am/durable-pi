import {
  createEffectActor,
  send,
  waitFor,
  type EffectActor,
} from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Queue, Scope } from "effect"

import { orDieAll } from "../../shared/effect"
import { handoffObserverMachine } from "../handoff-observer.machine"
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
    let actor:
      | EffectActor<ReturnType<typeof handoffObserverMachine>>
      | undefined
    let pending = 0
    const finish = () => Deferred.doneUnsafe(ended, Effect.void)
    const write = (event: object) => {
      if (!actor?.getSnapshot().matches("open")) return
      if (pending >= 16) {
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
    const cleanup = (close: () => Promise<unknown>) =>
      Effect.tryPromise({ try: close, catch: (cause) => cause }).pipe(
        // Ordinary native pipe-closure rejection remains a quiet disconnect.
        // A structured Cause is an actual failed teardown, not that signal.
        Effect.catch((cause) =>
          Cause.isCause(cause)
            ? Effect.failCause(cause).pipe(orDieAll)
            : Effect.void
        )
      )
    const program = Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const failures: Cause.Cause<unknown>[] = []
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() =>
          failures.length
            ? Effect.failCause(
                Cause.fromReasons(failures.flatMap((cause) => cause.reasons))
              ).pipe(orDieAll)
            : Effect.void
        )
      )
      const observe = (work: Effect.Effect<void>) =>
        work.pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (
                Exit.isFailure(exit) &&
                (Cause.hasDies(exit.cause) ||
                  (Cause.hasInterrupts(exit.cause) &&
                    !Cause.hasInterruptsOnly(exit.cause)))
              )
                failures.push(exit.cause)
            })
          )
        )
      yield* Effect.addFinalizer(() =>
        Effect.all(
          [
            cleanup(() =>
              pipe.readable.locked ? Promise.resolve() : pipe.readable.cancel()
            ).pipe(Effect.exit),
            cleanup(() => writer.abort()).pipe(Effect.exit),
          ],
          { concurrency: "unbounded" }
        ).pipe(
          Effect.flatMap((exits) => {
            const reasons = exits.flatMap((exit) =>
              Exit.isFailure(exit) ? exit.cause.reasons : []
            )
            return reasons.length
              ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
              : Effect.void
          })
        )
      )
      actor = yield* createEffectActor(
        handoffObserverMachine({
          admit: Effect.acquireRelease(
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
            (release) => Effect.sync(() => release?.())
          ).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.map(Boolean)
          ),
          admitted: (accepted) =>
            Deferred.succeed(started, accepted).pipe(Effect.asVoid),
          control: observe(
            Effect.sync(() => write({ stage: "control-start" })).pipe(
              Effect.andThen(Effect.sleep(250)),
              Effect.andThen(Effect.sync(() => write({ stage: "ready" })))
            )
          ),
          heartbeat: observe(Effect.sync(() => write({ stage: "heartbeat" }))),
          confirm: observe(
            Effect.gen(function* () {
              const event = yield* Queue.take(confirmations)
              yield* Effect.sleep(0)
              write({ ...event, stage: "yielded" })
              yield* confirmation
              write({ ...event, stage: "confirmed" })
            })
          ),
          ended: Deferred.await(ended),
        })
      )
      const completed = yield* waitFor(
        actor,
        (snapshot) => snapshot.status === "done"
      )
      return yield* completed.output!
    }).pipe(Effect.scoped)
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        run(program, { signal: AbortSignal.any([signal, cancelled.signal]) })
      ),
      (task) =>
        Effect.gen(function* () {
          const owned = task.then((exit) => {
            if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
              throw exit.cause
          })
          // The runtime owner observes failed cleanup after response transfer.
          // Also attach a local handler in case ownership registration throws.
          void owned.catch(() => {})
          own(owned)
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
          if (!actor || actor.getSnapshot().status !== "active")
            return new Response("Diagnostic unavailable", { status: 429 })
          const ack = yield* Deferred.make<void>()
          yield* send(actor, { type: "TRANSFER", ack })
          const transferred = yield* Effect.raceFirst(
            Deferred.await(ack).pipe(Effect.as(true)),
            Effect.promise(() => task).pipe(Effect.as(false))
          )
          return transferred
            ? response
            : new Response("Diagnostic unavailable", { status: 429 })
        }),
      (task) =>
        actor?.getSnapshot().context.transferred
          ? Effect.void
          : Effect.gen(function* () {
              cancelled.abort()
              const exit = yield* Effect.promise(() => task)
              if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
                return yield* Effect.failCause(exit.cause).pipe(orDieAll)
            })
    )
  }
)
