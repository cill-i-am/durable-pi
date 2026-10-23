import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit } from "effect"

import {
  browserOperationMachine,
  type BrowserOperationWork,
} from "./operation.machine"

/** The tab permit encloses this scope, including late native work and cleanup. */
export function runBrowserOperation<E>(work: BrowserOperationWork<E>) {
  return Effect.suspend(() => {
    const failures: Cause.Cause<E>[] = []
    const observe = <A>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failures.push(exit.cause)
          })
        )
      )
    return Effect.gen(function* () {
      const actor = yield* createEffectActor(
        browserOperationMachine({
          admit: observe(work.admit),
          acquire: (record) => observe(work.acquire(record)),
          dispatch: (record) => observe(work.dispatch(record)),
          publish: (record, capture) => observe(work.publish(record, capture)),
        })
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) => {
        if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause))
          return Effect.void
        const reasons = failures
          .flatMap((failure) => failure.reasons)
          .filter(
            (reason, index, all) =>
              reason._tag !== "Interrupt" &&
              !exit.cause.reasons.some((present) =>
                Equal.equals(present, reason)
              ) &&
              !all
                .slice(0, index)
                .some((present) => Equal.equals(present, reason))
          )
        return reasons.length
          ? Effect.failCause(Cause.fromReasons(reasons))
          : Effect.void
      })
    )
  })
}
