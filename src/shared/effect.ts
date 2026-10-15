import { Cause, Effect, Equal, Exit } from "effect"

export const fatalCause = <TError>(
  cause: Cause.Cause<TError>
): Cause.Cause<never> =>
  Cause.fromReasons<never>(
    cause.reasons.map((reason): Cause.Reason<never> =>
      reason._tag === "Fail" ? Cause.makeDieReason(reason) : reason
    )
  )

/** Effect 4.0.1's orDie selects one Fail. Retain every reason, including the
 * complete annotated Fail reason when turning it into a defect payload. */
export const orDieAll = <T, TError, TRequirements>(
  work: Effect.Effect<T, TError, TRequirements>
): Effect.Effect<T, never, TRequirements> =>
  Effect.catchCause(work, (cause) => Effect.failCause(fatalCause(cause)))

/** Place before typed recovery/materialization. A failure accompanied by a
 * defect or interruption cannot become a normal rejection or fallback. */
export const preserveFatal = <T, TError, TRequirements>(
  work: Effect.Effect<T, TError, TRequirements>
): Effect.Effect<T, TError, TRequirements> =>
  Effect.catchCause(work, (cause) =>
    Effect.failCause(
      Cause.hasDies(cause) || Cause.hasInterrupts(cause)
        ? fatalCause(cause)
        : cause
    )
  )

/** Native timeout/race operators join their losing child but discard its Exit.
 * Observe that child once, then reattach missing failed teardown after the join.
 * The expected interruption used to stop the loser stays local to the race. */
export const observeCleanup = <
  T,
  TError,
  TRequirements,
  TOutput,
  TOutputError,
  TOutputRequirements,
>(
  work: Effect.Effect<T, TError, TRequirements>,
  use: (
    observed: Effect.Effect<T, TError, TRequirements>
  ) => Effect.Effect<TOutput, TOutputError, TOutputRequirements>
): Effect.Effect<TOutput, TOutputError, TOutputRequirements> =>
  Effect.suspend(() => {
    let failed: Cause.Cause<TError> | undefined
    const observed = work.pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) failed = exit.cause
        })
      )
    )
    return use(observed).pipe(
      Effect.onExit((exit) => {
        if (!failed || !Cause.hasDies(failed)) return Effect.void
        const retained = Exit.isFailure(exit) ? exit.cause.reasons : []
        const missing = failed.reasons.filter(
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
        // An ordinary winning failure already contains its defects. Do not
        // manufacture another Die from its checked failure or undo a mapping.
        if (!missing.some((reason) => reason._tag === "Die")) return Effect.void
        return Effect.failCause(fatalCause(Cause.fromReasons(missing)))
      })
    )
  })
