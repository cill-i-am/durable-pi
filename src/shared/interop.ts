import { Cause, Context, Effect } from "effect"

import { orDieAll } from "./effect"

/** A local Effect runner may reject with a full Cause. Translate only Fail
 * reasons; defects, interruption and annotations retain their meanings. */
export const nativeFailure = <TError>(
  cause: unknown,
  onRejected: (cause: unknown, channel: "failure" | "rejection") => TError
): Cause.Cause<TError> => {
  try {
    return Cause.isCause(cause)
      ? Cause.fromReasons(
          cause.reasons.map((reason): Cause.Reason<TError> => {
            if (reason._tag !== "Fail") return reason
            const annotations = Context.makeUnsafe(reason.annotations)
            try {
              return Cause.makeFailReason(
                onRejected(reason.error, "failure")
              ).annotate(annotations)
            } catch (defect) {
              // One failed classification must not erase other Die/Interrupt
              // reasons in the same native Cause.
              return Cause.makeDieReason(defect).annotate(annotations)
            }
          })
        )
      : Cause.fail(onRejected(cause, "rejection"))
  } catch (defect) {
    return Cause.die(defect)
  }
}

/** Interruption signals a foreign operation and joins its actual settlement. */
export const nativeOperation = <T, TError>(
  start: (signal: AbortSignal) => Promise<T>,
  onRejected: (cause: unknown, channel: "failure" | "rejection") => TError
) =>
  Effect.callback<T, TError>((resume, signal) => {
    let work: Promise<T>
    let failed: Cause.Cause<TError> | undefined
    let delivered = false
    try {
      work = start(signal)
    } catch (cause) {
      resume(Effect.die(cause))
      return
    }
    work.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => {
        failed = nativeFailure(cause, onRejected)
        const failure = failed
        resume(
          Effect.suspend(() => {
            delivered = true
            return Effect.failCause(failure)
          })
        )
      }
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
            ? Effect.failCause(failed).pipe(orDieAll)
            : Effect.void
        )
      )
    )
  })

export const releaseUnreadResponse = (response: Response) => {
  const body = response.body
  return body && !response.bodyUsed && !body.locked
    ? Effect.promise(() => body.cancel())
    : Effect.void
}

/** Own even a response acquired after abort; a reader owns consumed bodies. */
export const nativeResponse = <TError>(
  start: (signal: AbortSignal) => Promise<Response>,
  onRejected: (cause: unknown, channel: "failure" | "rejection") => TError
) =>
  Effect.gen(function* () {
    let response: Response | undefined
    yield* Effect.addFinalizer(() =>
      response ? releaseUnreadResponse(response) : Effect.void
    )
    return yield* nativeOperation(
      (signal) =>
        start(signal).then((value) => {
          response = value
          return value
        }),
      onRejected
    )
  })
