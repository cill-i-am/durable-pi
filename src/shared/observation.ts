import { Cause, Effect, Exit } from "effect"
import { nativeFailure } from "./interop"
import { orDieAll } from "./effect"

/** Data-only observations can outlive a display deadline. The native owner keeps
 * the real settlement, including late validation defects; no resource transfers. */
export function nativeObservation<T, TError>(
  read: () => Promise<T>,
  own: (work: Promise<void>) => void,
  rejected: (cause: unknown, channel: "failure" | "rejection") => TError
): Effect.Effect<T, TError> {
  return Effect.yieldNow.pipe(
    Effect.andThen(
      Effect.suspend(() => {
        let work: Promise<T>
        try {
          work = read()
        } catch (cause) {
          return Effect.die(cause)
        }
        const result = work.then(
          (value): Exit.Exit<T, TError> => Exit.succeed(value),
          (cause: unknown): Exit.Exit<T, TError> =>
            Exit.failCause(nativeFailure(cause, rejected))
        )
        const retained = result.then((exit) => {
          if (
            Exit.isFailure(exit) &&
            (Cause.hasDies(exit.cause) || Cause.hasInterrupts(exit.cause))
          )
            throw exit.cause
        })
        try {
          own(retained)
        } catch (defect) {
          // Registration failed: the local join below now reports the complete
          // outcome, including late defects. The abandoned owner branch is handled.
          void retained.catch(() => {})
          return Effect.promise(() => result).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.failCause(
                    Cause.combine(Cause.die(defect), exit.cause)
                  ).pipe(orDieAll)
                : Effect.die(defect)
            ),
            Effect.uninterruptible
          )
        }
        return Effect.promise(() => result).pipe(
          Effect.flatMap((exit) =>
            Exit.isSuccess(exit)
              ? Effect.succeed(exit.value)
              : Effect.failCause(exit.cause)
          )
        )
      })
    )
  )
}
