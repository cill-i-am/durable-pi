import { send as sendEffect, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Semaphore } from "effect"
import { useCallback, useLayoutEffect, useState } from "react"

import { makeSoundAudition } from "./sound-owner"
import {
  soundView,
  type SoundEvent,
  type SoundMachine,
  type SoundSnapshot,
} from "./sound.machine"

export function useSoundAudition() {
  // React cannot await effect cleanup. This per-component permit also prevents
  // Strict Mode's replacement owner from starting before prior cleanup joins.
  const [ownership] = useState(() => Semaphore.makeUnsafe(1))
  const [owned, setOwned] = useState<{
    actor: EffectActor<SoundMachine>
    snapshot: SoundSnapshot
    live: () => boolean
  } | null>(null)
  useLayoutEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      ownership.withPermits(1)(
        Effect.gen(function* () {
          const actor = yield* makeSoundAudition()
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              actor.subscribe((snapshot) => {
                if (mounted) setOwned({ actor, snapshot, live: () => mounted })
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          const hide = () => {
            if (document.hidden) actor.send({ type: "HIDE" })
          }
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              document.addEventListener("visibilitychange", hide)
            ),
            () =>
              Effect.sync(() =>
                document.removeEventListener("visibilitychange", hide)
              )
          )
          if (mounted)
            setOwned({
              actor,
              snapshot: actor.getSnapshot(),
              live: () => mounted,
            })
          return yield* Effect.never
        }).pipe(Effect.scoped)
      )
    )
    return () => {
      mounted = false
      Effect.runFork(
        Fiber.interrupt(fiber).pipe(
          Effect.andThen(Fiber.await(fiber)),
          Effect.flatMap((exit) =>
            Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.logError(exit.cause)
              : Effect.void
          )
        )
      )
    }
  }, [ownership])
  const current = owned?.live() ? owned : null
  const actor = current?.actor
  const send = useCallback(
    (event: SoundEvent) => {
      if (actor) Effect.runFork(sendEffect(actor, event))
    },
    [actor]
  )
  return { ...soundView(current?.snapshot), send }
}
