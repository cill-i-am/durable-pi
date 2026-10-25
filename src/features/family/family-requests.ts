import { Cause, Effect } from "effect"

import { fatalCause, preserveFatal } from "../../shared/effect"
import { nativeOperation } from "../../shared/interop"

/** Foreign auth/network work keeps its actual Promise lifetime. The enclosing
 * owner reports structured native failure after its actor's joined shutdown. */
export function makeFamilyRequests() {
  return Effect.gen(function* () {
    const lifetime = new AbortController()
    let failure: Cause.Cause<never> | undefined
    yield* Effect.addFinalizer(() =>
      failure ? Effect.failCause(failure) : Effect.void
    )
    yield* Effect.addFinalizer(() => Effect.sync(() => lifetime.abort()))
    return {
      revoke: () => lifetime.abort(),
      active: () => !lifetime.signal.aborted,
      request: <T>(start: (signal: AbortSignal) => Promise<T>) =>
        nativeOperation(
          async (owned) => {
            const signal = AbortSignal.any([owned, lifetime.signal])
            signal.throwIfAborted()
            try {
              return await start(signal)
            } catch (cause) {
              if (
                Cause.isCause(cause) &&
                (Cause.hasDies(cause) || Cause.hasInterrupts(cause))
              ) {
                const next = fatalCause(cause)
                failure = failure ? Cause.combine(failure, next) : next
              }
              throw cause
            }
          },
          (cause) => cause
        ).pipe(preserveFatal),
    }
  })
}
