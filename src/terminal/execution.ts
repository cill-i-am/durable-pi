import { createEffectActor, waitFor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit, Ref } from "effect"

import {
  terminalExecutionMachine,
  type TerminalExecutionWork,
} from "./execution.machine"

/** The command owns this scope; request observers never own its cancellation. */
export function executeTerminal<E>(work: TerminalExecutionWork<E>) {
  return Effect.gen(function* () {
    const failed = yield* Ref.make<Cause.Cause<E> | undefined>(undefined)
    const observe = <A>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit) ? Ref.set(failed, exit.cause) : Effect.void
        )
      )
    return yield* Effect.gen(function* () {
      const actor = yield* createEffectActor(
        terminalExecutionMachine({
          ...work,
          close: observe(work.close),
          restore: observe(work.restore),
          command: observe(work.command),
          import: observe(work.import),
          session: observe(work.session),
          export: observe(work.export),
          checkpoint: observe(work.checkpoint),
        })
      )
      const done = yield* waitFor(
        actor,
        (state) => state.status === "done"
      ).pipe(Effect.orDie)
      return yield* done.output!
    }).pipe(
      Effect.scoped,
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (!Exit.isFailure(exit) || !Cause.hasInterrupts(exit.cause)) return
          const failure = yield* Ref.get(failed)
          const reasons =
            failure?.reasons.filter(
              (reason) =>
                reason._tag !== "Interrupt" &&
                !exit.cause.reasons.some((present) =>
                  Equal.equals(present, reason)
                )
            ) ?? []
          if (reasons.length)
            return yield* Effect.failCause(Cause.fromReasons(reasons))
        })
      )
    )
  })
}
