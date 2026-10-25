import { send, type EffectActor } from "@xstate/effect"
import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { AccessMode, ToolPolicy } from "@/access/contracts"

import { accessRequests, makeAccessOwner } from "./access-owner"
import { accessMachine } from "./access.machine"

type Machine = ReturnType<typeof accessMachine>
export function useAccess(agentId: string, open: boolean, onSaved: () => void) {
  const [actor, setActor] = useState<EffectActor<Machine> | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<Machine> | null>(null)
  const saved = useRef(onSaved)
  saved.current = onSaved
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const owned = yield* makeAccessOwner(
          { agentId, open: false },
          accessRequests(agentId)
        )
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
            owned.on("saved", () => {
              if (mounted) saved.current()
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
    if (actor) Effect.runFork(send(actor, { type: "VIEW", open }))
  }, [actor, open])
  const current = snapshot?.context.view.agentId === agentId ? snapshot : null
  const owner =
    actor?.getSnapshot().context.view.agentId === agentId ? actor : null
  return {
    policies: current?.context.state?.tools,
    busy: current?.matches("saving") ? current.context.request!.name : "",
    loading: !current || current.matches("loading"),
    error: current?.context.error ?? "",
    refresh: () => {
      if (owner) Effect.runFork(send(owner, { type: "REFRESH" }))
    },
    update: (tool: ToolPolicy, mode: AccessMode) => {
      if (owner)
        Effect.runFork(
          send(owner, {
            type: "CHANGE",
            name: tool.name,
            expectedRevision: tool.revision,
            mode,
          })
        )
    },
  }
}
