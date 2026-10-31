import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { makeApprovalOwner } from "./access-owner"
import {
  approvalMachine,
  sameApprovalView,
  type ApprovalView,
  type ApprovalRequest,
} from "./approval.machine"
import { futurePermissionCurrent } from "./decision"

type Machine = ReturnType<typeof approvalMachine>
export function useApproval(view: ApprovalView) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const { agentId, approval, disabled, policy } = view
  const currentView = useMemo(
    () => ({ agentId, approval, disabled, policy }),
    [agentId, approval, disabled, policy]
  )
  const latest = useRef(currentView)
  latest.current = currentView
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeApprovalOwner(latest.current)
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
  }, [agentId])
  useEffect(() => {
    if (actor?.getSnapshot().context.view.agentId === currentView.agentId)
      Effect.runFork(send(actor, { type: "VIEW", ...currentView }))
  }, [actor, currentView])
  const current =
    snapshot && sameApprovalView(snapshot.context.view, view) ? snapshot : null
  const owner =
    actor?.getSnapshot().context.view.agentId === agentId ? actor : null
  const busy = current?.matches("submitting") ?? false
  const uncertain = current?.matches("uncertain")
    ? current.context.request
    : null
  const confirmed = current?.context.confirmed ?? null
  const ready = current !== null && owner !== null
  return {
    ready,
    busy,
    uncertain: uncertain !== null,
    confirmed:
      confirmed?.remember && !futurePermissionCurrent(confirmed, view.policy)
        ? { ...confirmed, remember: false }
        : confirmed,
    error: current?.context.error ?? "",
    blocked: (approve: boolean, remember = false) =>
      !ready ||
      approvalBlocked(currentView, busy, uncertain, approve, remember),
    decide: (approve: boolean, remember = false) => {
      if (owner)
        Effect.runFork(send(owner, { type: "SUBMIT", view, approve, remember }))
    },
  }
}

function approvalBlocked(
  view: ApprovalView,
  busy: boolean,
  uncertain: ApprovalRequest | null,
  approve: boolean,
  remember: boolean
) {
  if (busy || view.disabled) return true
  if (
    uncertain &&
    (uncertain.approve !== approve ||
      uncertain.remember !== remember ||
      (remember && uncertain.view.policy?.revision !== view.policy?.revision))
  )
    return true
  return (
    remember &&
    (!view.policy ||
      view.policy.name !== view.approval.tool ||
      view.policy.mode === "deny")
  )
}
