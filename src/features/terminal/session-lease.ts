import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"

import { ApiError } from "@/http/client"
import { nativeOperation } from "@/shared/interop"

import { terminalWorkFailures } from "./owned-work"
import { sessionLeaseMachine, type LeaseState } from "./session-lease.machine"
export type { LeaseState } from "./session-lease.machine"

export function maintainSessionLease(
  initialExpiry: number,
  renew: (signal: AbortSignal) => Promise<{ expiresAt: number }>,
  changed: (state: LeaseState) => void
) {
  let observing = true
  let projected: LeaseState = { ended: false, error: "" }
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const observe = yield* terminalWorkFailures
      const actor = yield* createEffectActor(
        sessionLeaseMachine(
          observe(nativeOperation(renew, (cause) => cause)),
          (cause) => {
            const error = cause.reasons.find((reason) => reason._tag === "Fail")
            if (
              error?._tag !== "Fail" ||
              !(error.error instanceof ApiError) ||
              ![401, 403, 409].includes(error.error.status)
            )
              return undefined
            return error.error.status === 401
              ? "Sign-in expired. The terminal will stop without saving. Sign in again to continue."
              : "This terminal session has ended. Check its result before reopening."
          }
        ),
        { input: { expiresAt: initialExpiry } }
      )
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          actor.subscribe((snapshot) => {
            const next = {
              ended: snapshot.context.ended,
              error: snapshot.context.error,
            }
            if (
              observing &&
              (next.ended !== projected.ended || next.error !== projected.error)
            ) {
              projected = next
              changed(next)
            }
          })
        ),
        (subscription) => Effect.sync(() => subscription.unsubscribe())
      )
      yield* waitFor(actor, (snapshot) => snapshot.status === "done")
    }).pipe(Effect.scoped)
  )
  const closed = Effect.runPromise(Fiber.await(fiber))
  const stop = () => {
    observing = false
    Effect.runFork(Fiber.interrupt(fiber))
  }
  void closed.then((exit) => {
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
      Effect.runFork(Effect.logError(exit.cause))
  })
  return Object.assign(stop, { closed })
}
