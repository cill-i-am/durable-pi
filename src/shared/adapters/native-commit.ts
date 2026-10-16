import { Cause, Effect, Exit } from "effect"

import { fatalCause } from "../effect"
import { nativeFailure } from "../interop"

/** Interpret one Effect callback inside its native owner's transaction. The
 * private abort marker distinguishes ordinary callback rejection from a second
 * native settlement failure. It does not implement or retry a transaction. */
export function nativeCommit<TInput, T, TError, TRequirements, TNativeError>(
  start: (
    change: (input: TInput) => Promise<T>,
    signal: AbortSignal
  ) => Promise<T>,
  change: (input: TInput) => Effect.Effect<T, TError, TRequirements>,
  rejected: (cause: unknown, channel: "failure" | "rejection") => TNativeError
): Effect.Effect<T, TError | TNativeError, TRequirements> {
  return Effect.gen(function* () {
    const invocation = yield* Effect.context<TRequirements>()
    return yield* Effect.callback<T, TError | TNativeError>(
      (resume, signal) => {
        const abort = new Error("Effect transaction callback aborted")
        let callbackCause: Cause.Cause<TError> | undefined
        let failed: Cause.Cause<TError | TNativeError> | undefined
        let delivered = false
        const failure = (cause: unknown) => {
          if (!callbackCause) return nativeFailure(cause, rejected)
          if (cause === abort) return callbackCause
          // Pi settles the failed callback before rethrowing its marker. A
          // different rejection is another failure, not proof of safe rollback.
          return Cause.combine(
            callbackCause,
            Cause.isCause(cause) ? fatalCause(cause) : Cause.die(cause)
          )
        }
        const deliver = (cause: Cause.Cause<TError | TNativeError>) => {
          failed = cause
          resume(
            Effect.suspend(() => {
              delivered = true
              return Effect.failCause(cause)
            })
          )
        }
        let work: Promise<T>
        try {
          work = start(async (input) => {
            const exit = await Effect.runPromiseExitWith(invocation)(
              Effect.yieldNow.pipe(
                Effect.andThen(Effect.suspend(() => change(input)))
              ),
              { signal }
            )
            if (Exit.isSuccess(exit)) return exit.value
            callbackCause = exit.cause
            throw abort
          }, signal)
        } catch (cause) {
          resume(Effect.die(cause))
          return
        }
        work.then(
          (value) =>
            callbackCause
              ? deliver(
                  Cause.combine(
                    callbackCause,
                    Cause.die(
                      new Error("Native commit accepted a failed callback")
                    )
                  )
                )
              : resume(Effect.succeed(value)),
          (cause) => deliver(failure(cause))
        )
        return Effect.promise(() =>
          work.then(
            () => undefined,
            () => undefined
          )
        ).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              !delivered && failed && Cause.hasDies(failed)
                ? Effect.failCause(fatalCause(failed))
                : Effect.void
            )
          )
        )
      }
    )
  })
}
