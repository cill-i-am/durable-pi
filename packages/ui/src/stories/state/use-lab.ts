import { send as sendEffect, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useCallback, useId, useLayoutEffect, useState } from "react"

import { makeLab } from "./lab-owner"
import {
  labView,
  type LabEvent,
  type LabMachine,
  type LabScenario,
  type LabSnapshot,
} from "./lab.machine"

export function useLab(
  options: { scenario?: LabScenario; delayMs?: number; identity?: string } = {}
) {
  const generatedId = useId()
  const identity = options.identity ?? generatedId
  const scenario = options.scenario ?? "success"
  const delayMs = options.delayMs ?? 600
  const [owned, setOwned] = useState<{
    identity: string
    actor: EffectActor<LabMachine>
    snapshot: LabSnapshot
    live: () => boolean
  } | null>(null)
  useLayoutEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const { actor } = yield* makeLab()
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((snapshot) => {
              if (mounted)
                setOwned({ identity, actor, snapshot, live: () => mounted })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted)
          setOwned({
            identity,
            actor,
            snapshot: actor.getSnapshot(),
            live: () => mounted,
          })
        return yield* Effect.never
      }).pipe(Effect.scoped)
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
  }, [identity])
  const current = owned?.identity === identity && owned.live() ? owned : null
  const actor = current?.actor
  const snapshot = current?.snapshot
  const send = useCallback(
    (event: LabEvent) => {
      if (actor) Effect.runFork(sendEffect(actor, event))
    },
    [actor]
  )
  return {
    ...labView(snapshot),
    snapshot,
    send,
    start: () => send({ type: "START", scenario, delayMs }),
    retry: () => send({ type: "RETRY" }),
    cancel: () => send({ type: "CANCEL" }),
    reset: () => send({ type: "RESET" }),
    check: () => send({ type: "CHECK" }),
    interactionProps: {
      onPointerEnter: () => send({ type: "POINTER_ENTER" }),
      onPointerLeave: () => send({ type: "POINTER_LEAVE" }),
      onPointerDown: () => send({ type: "POINTER_DOWN" }),
      onPointerUp: () => send({ type: "POINTER_UP" }),
      onPointerCancel: () => send({ type: "POINTER_LEAVE" }),
      onFocus: () => send({ type: "FOCUS" }),
      onBlur: () => send({ type: "BLUR" }),
    },
  }
}
