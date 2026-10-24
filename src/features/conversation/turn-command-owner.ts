import { createEffectActor, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Equal, Exit } from "effect"

import { orDieAll } from "@/shared/effect"

import { turnCommandMachine, type TurnCommand } from "./turn-command.machine"

export function makeTurnCommand(
  request: (input: TurnCommand) => Effect.Effect<void, unknown>
) {
  return Effect.gen(function* () {
    let actor: EffectActor<ReturnType<typeof turnCommandMachine>> | undefined
    const failed = new Map<string, Cause.Cause<unknown>>()
    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        const context = actor?.getSnapshot().context
        const reasons = [
          context?.failure,
          ...Object.values(context?.cancelFailures ?? {}),
        ].flatMap((cause) => (Cause.isCause(cause) ? cause.reasons : []))
        const missing = [...failed.values()]
          .filter((cause) => !Cause.hasInterruptsOnly(cause))
          .flatMap((cause) => cause.reasons)
          .filter(
            (reason) =>
              !reasons.some((present) => Equal.equals(present, reason))
          )
        return missing.length
          ? Effect.failCause(Cause.fromReasons(missing)).pipe(orDieAll)
          : Effect.void
      })
    )
    actor = yield* createEffectActor(
      turnCommandMachine((input) =>
        Effect.suspend(() => {
          const key = `${input.action}:${input.turnId}`
          failed.delete(key)
          return request(input).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isFailure(exit)) failed.set(key, exit.cause)
              })
            )
          )
        })
      )
    )
    return actor
  })
}
