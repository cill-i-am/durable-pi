import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { makeMailboxControlOwner } from "./mailbox-control-owner"
import {
  mailboxControlAllowed,
  mailboxControlMachine,
  type MailboxControlView,
  type MailboxRequest,
} from "./mailbox-control.machine"

type Machine = ReturnType<typeof mailboxControlMachine>
export function useMailboxControl(
  agentId: string,
  state: MailboxControlView["state"],
  refresh: () => Promise<void>
) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const view = useMemo(() => ({ agentId, state }), [agentId, state])
  const latest = useRef(view)
  latest.current = view
  const reload = useRef(refresh)
  reload.current = refresh
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeMailboxControlOwner(latest.current)
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            owned.on("acknowledged", () => {
              if (mounted && latest.current.agentId === agentId)
                void reload.current()
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
    if (actor?.getSnapshot().context.view.agentId === agentId)
      Effect.runFork(send(actor, { type: "VIEW", ...view }))
  }, [actor, agentId, view])
  const current = snapshot?.context.view.agentId === agentId ? snapshot : null
  const pending = current?.matches("submitting")
    ? (current.context.request?.id ?? null)
    : null
  const uncertain = current?.matches("uncertain")
    ? current.context.request
    : null
  return {
    pending,
    error: current?.context.error ?? "",
    blocked: (id: string, action: MailboxRequest["action"]) =>
      !current ||
      pending !== null ||
      !mailboxControlAllowed(view, { id, action }, Date.now()) ||
      (!!uncertain &&
        action !== "cancel" &&
        (uncertain.id !== id || uncertain.action !== action)),
    submit: (id: string, action: MailboxRequest["action"]) => {
      if (actor?.getSnapshot().context.view.agentId === agentId)
        Effect.runFork(send(actor, { type: "SUBMIT", agentId, id, action }))
    },
  }
}
