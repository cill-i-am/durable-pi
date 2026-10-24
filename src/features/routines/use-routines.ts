import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useLayoutEffect, useRef, useState } from "react"
import type { EventFromLogic, SnapshotFrom } from "xstate"

import { makeRoutinesOwner, routinesRequests } from "./routines-owner"
import {
  type RoutineCommand,
  type routinesUiMachine,
} from "./routines-ui.machine"

type Machine = ReturnType<typeof routinesUiMachine>
export function useRoutines(
  agentId: string,
  onApplied: () => void,
  onPendingChange: (pending: boolean) => void,
  view = "list"
) {
  const callback = useRef(onApplied),
    currentView = useRef(view)
  useLayoutEffect(() => {
    callback.current = onApplied
    currentView.current = view
  }, [onApplied, view])
  const [owner, setOwner] = useState<{
    agentId: string
    actor: EffectActor<Machine>
  } | null>(null)
  const [state, setState] = useState<{
    agentId: string
    snapshot: SnapshotFrom<Machine>
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.scoped(
        Effect.gen(function* () {
          const actor = yield* makeRoutinesOwner(
            view,
            routinesRequests(agentId),
            document.visibilityState === "visible"
          )
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              actor.subscribe((snapshot) => {
                if (mounted) setState({ agentId, snapshot })
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              actor.on("applied", (event) => {
                if (mounted && currentView.current === event.view)
                  callback.current()
              })
            ),
            (subscription) => Effect.sync(() => subscription.unsubscribe())
          )
          const visible = () =>
            Effect.runFork(
              send(actor, {
                type: "VISIBLE",
                visible: document.visibilityState === "visible",
              })
            )
          yield* Effect.acquireRelease(
            Effect.sync(() => {
              document.addEventListener("visibilitychange", visible)
              visible()
            }),
            () =>
              Effect.sync(() =>
                document.removeEventListener("visibilitychange", visible)
              )
          )
          if (mounted) {
            setOwner({ agentId, actor })
            setState({ agentId, snapshot: actor.getSnapshot() })
          }
          return yield* Effect.never
        })
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
    // A changed agent closes its own scope. View changes are machine events.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [agentId])
  const actor = owner?.agentId === agentId ? owner.actor : null
  const snapshot = state?.agentId === agentId ? state.snapshot : null
  useLayoutEffect(() => {
    if (actor) Effect.runFork(send(actor, { type: "VIEW", view }))
  }, [actor, view])
  const busy =
    !!snapshot &&
    (snapshot.matches("submitting") ||
      snapshot.matches("resolving") ||
      snapshot.matches("stopping"))
  const attempt = snapshot?.context.attempt ?? null,
    stopId = snapshot?.context.stopId ?? null
  const pending = routinePending(busy, attempt, stopId)
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
  const dispatch = (event: EventFromLogic<Machine>) =>
    actor
      ? Effect.runPromise(send(actor, event)).then(() => true)
      : Promise.resolve(false)
  return {
    data: snapshot?.context.data ?? { routines: [], runs: [] },
    loading:
      !snapshot ||
      (snapshot.context.data === null && snapshot.matches("loading")),
    error: snapshot?.context.error ?? "",
    busy: busy || !actor,
    attempt,
    stopId,
    refresh: () => dispatch({ type: "REFRESH" }),
    retryLoad: () => dispatch({ type: "REFRESH" }),
    send: (change: RoutineCommand) => dispatch({ type: "SEND", change, view }),
    resolve: () => dispatch({ type: "RESOLVE" }),
    retry: () => dispatch({ type: "RETRY" }),
    retryStop: () => dispatch({ type: "RETRY_STOP" }),
    stop: (id: string) => dispatch({ type: "STOP", id }),
  }
}

function routinePending(
  busy: boolean,
  attempt: RoutineCommand | null,
  stopId: string | null
) {
  return busy || !!attempt || !!stopId
}
