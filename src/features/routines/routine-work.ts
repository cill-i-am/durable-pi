import { Cause, Effect, Equal } from "effect"

import { fatalCause, orDieAll } from "@/shared/effect"

/** Registered before local actors so failed cleanup remains visible only after
 * each interrupted request has joined. Observe the raw Exit before recovery can
 * replace a compound failure with the local cancellation reason. */
export const routineWorkFailures = Effect.gen(function* () {
  const failures: Cause.Cause<unknown>[] = []
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const reasons = failures
        .flatMap((cause) => cause.reasons)
        .filter(
          (reason, index, all) =>
            all.findIndex((other) => Equal.equals(other, reason)) === index
        )
      return reasons.length
        ? Effect.failCause(Cause.fromReasons(reasons)).pipe(orDieAll)
        : Effect.void
    })
  )
  return <A, E, R>(work: Effect.Effect<A, E, R>) =>
    work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (
            exit._tag === "Failure" &&
            (Cause.hasDies(exit.cause) ||
              (Cause.hasInterrupts(exit.cause) &&
                !Cause.hasInterruptsOnly(exit.cause)))
          )
            failures.push(fatalCause(exit.cause))
        })
      )
    )
})
