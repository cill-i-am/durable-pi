import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import { backgroundAdmissionMachine } from "./background-admission.machine"

/** One scoped acceptance, notification or explicitly requested retry. This
 * never retries a provider action or invents a new handoff/operation identity. */
export function admitBackground<A, E>(work: {
  arm: (deadline: number) => Effect.Effect<void, E>
  accept: (deadline: number) => Effect.Effect<A, E>
  wake: Effect.Effect<unknown, E>
}) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<E> | undefined>(undefined)
    const observe = <T>(effect: Effect.Effect<T, E>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        backgroundAdmissionMachine({
          arm: (deadline) => observe(work.arm(deadline)),
          accept: (deadline) => observe(work.accept(deadline)),
          wake: observe(work.wake),
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
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      )
    )
  })
}
