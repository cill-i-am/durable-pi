import { Cause, Effect, Equal } from "effect"

import { orDieAll } from "@/shared/effect"

/** Register before the actor: owning-scope teardown joins invocation cleanup
 * first, then reports every late compound Cause instead of losing it in Exit. */
export const terminalWorkFailures = Effect.gen(function* () {
  const failures: Cause.Cause<unknown>[] = []
  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const reasons = failures
        .flatMap((failure) => failure.reasons)
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
          if (exit._tag === "Failure" && Cause.hasDies(exit.cause))
            failures.push(exit.cause)
        })
      )
    )
})
