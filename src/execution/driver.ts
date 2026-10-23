import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit } from "effect"

import type { ExecutionStorageError } from "./contracts"
import { executionDriverMachine, type ExecutionWork } from "./driver.machine"

/** The run owns its actor scope, including every invoked stage's finalizers. */
export const executeRun = (work: ExecutionWork) =>
  Effect.suspend(() => {
    let failed: Cause.Cause<ExecutionStorageError> | undefined
    const observe = <A>(effect: Effect.Effect<A, ExecutionStorageError>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) failed = exit.cause
          })
        )
      )
    return Effect.gen(function* () {
      const actor = yield* createEffectActor(
        executionDriverMachine({
          authorize: observe(work.authorize),
          execute: observe(work.execute),
          publish: (output) => observe(work.publish(output)),
          cancel: observe(work.cancel),
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
        const missing =
          failed?.reasons.filter(
            (reason) =>
              reason._tag !== "Interrupt" &&
              !exit.cause.reasons.some((present) =>
                Equal.equals(present, reason)
              )
          ) ?? []
        return missing.length
          ? Effect.failCause(Cause.fromReasons(missing))
          : Effect.void
      })
    )
  })
