import { Cause, Effect } from "effect"

import { orDieAll } from "@/shared/effect"
import { nativeOperation } from "@/shared/interop"

/** Agent UI scopes retain native request occupancy, including late cleanup.
 * Revocation fences callbacks before React starts disposing their actor. */
export function makeAgentRequests() {
  return Effect.gen(function* () {
    const lifetime = new AbortController()
    let failure: Cause.Cause<unknown> | undefined
    yield* Effect.addFinalizer(() =>
      failure ? Effect.failCause(failure).pipe(orDieAll) : Effect.void
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
              // Actor shutdown materializes its child Exit. Retain fatal native
              // cleanup here so the enclosing scope still reports every reason.
              if (
                Cause.isCause(cause) &&
                (Cause.hasDies(cause) ||
                  (Cause.hasInterrupts(cause) &&
                    !Cause.hasInterruptsOnly(cause)))
              )
                failure = failure ? Cause.combine(failure, cause) : cause
              throw cause
            }
          },
          (cause) => cause
        ),
    }
  })
}
