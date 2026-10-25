import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { makeTaskControlOwner, taskControlRequests } from "./task-control-owner"
import {
  commandAction,
  sameTaskOwner,
  taskControlMachine,
  TaskControlView,
  type TaskIntent,
} from "./task-control.machine"

type Machine = ReturnType<typeof taskControlMachine>
export function useTaskControl(view: TaskControlView) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const identity = JSON.stringify([
    view.agentId,
    view.groupId,
    view.childId,
    view.prefix,
  ])
  const viewKey = JSON.stringify(view)
  const currentView = useMemo(
    () => Schema.decodeUnknownSync(TaskControlView)(JSON.parse(viewKey)),
    [viewKey]
  )
  const latest = useRef(currentView)
  latest.current = currentView
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeTaskControlOwner(
          latest.current,
          taskControlRequests(sessionStorage)
        )
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
  }, [identity])
  useEffect(() => {
    if (actor && sameTaskOwner(actor.getSnapshot().context.view, currentView))
      Effect.runFork(send(actor, { type: "VIEW", ...currentView }))
  }, [actor, currentView])
  const current =
    snapshot && sameTaskOwner(snapshot.context.view, view) ? snapshot : null
  const busy =
    !current ||
    current.matches("restoring") ||
    current.matches("preparing") ||
    current.matches("submitting")
  return {
    busy,
    sending:
      !!current &&
      (current.matches("preparing") || current.matches("submitting")),
    error: current?.context.error ?? "",
    acknowledged: current?.context.acknowledged ?? null,
    saved: (action: TaskIntent["action"]) =>
      current?.context.saved.find(
        (command) => commandAction(command) === action
      ) ?? null,
    blocked: (action: TaskIntent["action"]) =>
      !current?.matches("ready") ||
      (!!current?.context.saved.length &&
        action !== "stop" &&
        !current.context.saved.some(
          (command) => commandAction(command) === action
        )) ||
      (!view.active.includes(action) &&
        !current?.context.saved.some(
          (command) => commandAction(command) === action
        )),
    submit: (action: TaskIntent["action"], text = "") => {
      if (actor && sameTaskOwner(actor.getSnapshot().context.view, view))
        Effect.runFork(send(actor, { type: "SUBMIT", view, action, text }))
    },
  }
}
