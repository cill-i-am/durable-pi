import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import { makeDecisionDockOwner } from "./decision-dock-owner"
import {
  decisionDockMachine,
  type DecisionDockView,
} from "./decision-dock.machine"

type DockEvent = EventFromLogic<typeof decisionDockMachine>

export function useDecisionDock(view: DecisionDockView) {
  const { agentId, approvals } = view
  const currentView = useMemo(
    () => ({ agentId, approvals }),
    [agentId, approvals]
  )
  const latest = useRef(currentView)
  latest.current = currentView
  const [actor, setActor] = useState<EffectActor<
    typeof decisionDockMachine
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    typeof decisionDockMachine
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeDecisionDockOwner(latest.current)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) {
          setActor(owned)
          setSnapshot(owned.getSnapshot())
        }
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
  }, [view.agentId])
  useEffect(() => {
    if (actor?.getSnapshot().context.view.agentId === view.agentId)
      Effect.runFork(send(actor, { type: "VIEW", ...currentView }))
  }, [actor, currentView, view.agentId])
  const current =
    snapshot?.context.view.agentId === view.agentId ? snapshot : null
  const dispatch = useCallback(
    (event: DockEvent) => {
      if (actor?.getSnapshot().context.view.agentId === view.agentId)
        Effect.runFork(send(actor, event))
    },
    [actor, view.agentId]
  )
  return {
    snapshot: current,
    send: dispatch,
  }
}
