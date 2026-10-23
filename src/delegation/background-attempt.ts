import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import { backgroundAttemptMachine } from "./background-attempt.machine"
import type { BackgroundError } from "./background-mailbox"

export function runBackgroundAttempt(
  work: Parameters<typeof backgroundAttemptMachine>[0]
) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<BackgroundError> | undefined>(
      undefined
    )
    const observe = <T>(effect: Effect.Effect<T, BackgroundError>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        backgroundAttemptMachine({
          ...work,
          claim: observe(work.claim),
          dispatch: (row) => observe(work.dispatch(row)),
          record: (row, result) => observe(work.record(row, result)),
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
