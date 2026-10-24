import { createEffectActor } from "@xstate/effect"
import { Cause, Effect, Exit } from "effect"

import { orDieAll } from "@/shared/effect"

import {
  channelSettingsMachine,
  type Channel,
  type SettingsWork,
} from "./settings.machine"

export function makeChannelSettings(
  input: { channel: Channel; archived: boolean; open: boolean },
  work: SettingsWork
) {
  return Effect.gen(function* () {
    const failures = new Set<Cause.Cause<unknown>>()
    yield* Effect.addFinalizer(() =>
      failures.size
        ? Effect.failCause(
            Cause.fromReasons([...failures].flatMap((cause) => cause.reasons))
          ).pipe(orDieAll)
        : Effect.void
    )
    const observe = <T, R>(effect: Effect.Effect<T, unknown, R>) =>
      effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (
              Exit.isFailure(exit) &&
              Cause.hasDies(exit.cause) &&
              Cause.hasInterrupts(exit.cause)
            )
              failures.add(exit.cause)
          })
        )
      )
    return yield* createEffectActor(
      channelSettingsMachine({
        ...work,
        read: observe(work.read),
        change: (request) => observe(work.change(request)),
      }),
      { input }
    )
  })
}
