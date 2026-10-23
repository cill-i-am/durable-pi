import { Cause, Effect, Equal, Exit, type Scope } from "effect"

import { fatalCause } from "../shared/effect"

/** alpha.8 joins stopped invocations but does not expose their final Exit.
 * Retain every late failure after the actor's resource scope has joined. */
export const summaryScope = <A, E, R>(
  use: (
    observe: <T, TE, TR>(
      work: Effect.Effect<T, TE, TR>
    ) => Effect.Effect<T, TE, TR>
  ) => Effect.Effect<A, E, R>
): Effect.Effect<A, E, Exclude<R, Scope.Scope>> =>
  Effect.suspend(() => {
    const failed: Cause.Cause<unknown>[] = []
    return use((work) =>
      work.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failed.push(exit.cause)
          })
        )
      )
    ).pipe(
      Effect.scoped,
      Effect.onExit((exit) => {
        const retained = Exit.isFailure(exit) ? exit.cause.reasons : []
        const missing = failed
          .flatMap((cause) => cause.reasons)
          .filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !retained.some(
                (present) =>
                  Equal.equals(present, reason) ||
                  (present._tag === "Die" &&
                    reason._tag === "Fail" &&
                    Equal.equals(present.defect, reason))
              )
          )
        return missing.length &&
          ((Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)) ||
            missing.some((reason) => reason._tag === "Die"))
          ? Effect.failCause(fatalCause(Cause.fromReasons(missing)))
          : Effect.void
      })
    )
  })
