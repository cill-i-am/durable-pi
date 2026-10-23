import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import { coordinationAdmissionMachine } from "./admission.machine"

export function admitCoordination<A, E>(work: {
  arm: Effect.Effect<number, E>
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
        coordinationAdmissionMachine({
          arm: observe(work.arm),
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
