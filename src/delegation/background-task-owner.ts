import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Option, Ref, Semaphore } from "effect"

import {
  backgroundTaskDispatchMachine,
  type BackgroundNativeCommand,
  type BackgroundNativeWork,
} from "./background-task-dispatch.machine"
import type { DelegationFailure } from "./contracts"

/** One live owner per BackgroundTasks service/group, never leased or stolen.
 * Revocation commits before waiting for this permit. Native bridge settlement
 * and its joined cleanup keep ownership even when an RPC observer disappears. */
export function makeBackgroundTaskOwner() {
  const owner = Semaphore.makeUnsafe(1)
  const run = (work: BackgroundNativeWork) =>
    owner.withPermit(
      Effect.gen(function* () {
        const command = yield* Ref.make<BackgroundNativeCommand | undefined>(
          undefined
        )
        const failed = yield* Ref.make<
          Cause.Cause<DelegationFailure> | undefined
        >(undefined)
        const observe = <A>(effect: Effect.Effect<A, DelegationFailure>) =>
          effect.pipe(
            Effect.onExit((exit) =>
              Exit.isFailure(exit)
                ? Ref.update(failed, (prior) =>
                    prior ? Cause.combine(prior, exit.cause) : exit.cause
                  )
                : Effect.void
            )
          )
        return yield* Effect.gen(function* () {
          const actor = yield* createEffectActor(
            backgroundTaskDispatchMachine({
              claim: observe(work.claim).pipe(
                Effect.tap((value) => Ref.set(command, value))
              ),
              dispatch: (value) => observe(work.dispatch(value)),
              record: (value, result) => observe(work.record(value, result)),
            })
          )
          const done = yield* waitFor(
            actor,
            (state) => state.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        }).pipe(
          Effect.scoped,
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
                return
              // Official actor shutdown joins invocation fibers but suppresses their
              // onDone delivery. Keep the receipt uncertain and preserve late Cause.
              const failure = yield* Ref.get(failed)
              const claimed = yield* Ref.get(command)
              const recorded = claimed
                ? yield* work
                    .record(claimed, Exit.failCause(failure ?? exit.cause))
                    .pipe(Effect.exit)
                : Exit.void
              const reasons =
                failure?.reasons.filter(
                  (reason) =>
                    reason._tag !== "Interrupt" &&
                    !exit.cause.reasons.some((present) =>
                      Equal.equals(present, reason)
                    )
                ) ?? []
              if (Exit.isFailure(recorded))
                return yield* Effect.failCause(
                  reasons.length
                    ? Cause.combine(recorded.cause, Cause.fromReasons(reasons))
                    : recorded.cause
                )
              if (reasons.length)
                return yield* Effect.failCause(Cause.fromReasons(reasons))
            })
          )
        )
      })
    )
  return {
    run,
    /** Observation of native resource occupancy; never releases an active owner. */
    available: owner
      .withPermitsIfAvailable(1)(Effect.void)
      .pipe(Effect.map(Option.isSome)),
  }
}
