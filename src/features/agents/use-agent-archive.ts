import { Cause, Effect, Exit, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { AgentProfile } from "@/agents/contracts"
import { api } from "@/http/client"

import { makeAgentArchive } from "./agent-archive-owner"
import type { agentArchiveMachine, AgentArchive } from "./agent-archive.machine"

export function useAgentArchive(
  reconcile: (command: AgentArchive, signal: AbortSignal) => Promise<void>
) {
  const ports = useRef(reconcile)
  ports.current = reconcile
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeAgentArchive>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    ReturnType<typeof agentArchiveMachine>
  > | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeAgentArchive({
          write: ({ agent, archived }, signal) =>
            api("/api/agent/bots/archive", { id: agent.id, archived }, signal),
          reconcile: (command, signal) => ports.current(command, signal),
        })
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((value) => {
              if (mounted) setSnapshot(value)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(current.actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current?.revoke()
      owner.current = null
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
  }, [])
  const pending =
    snapshot?.matches("writing") || snapshot?.matches("reconciling") || false
  const unreconciled = snapshot?.matches("unreconciled") || false
  return {
    pending,
    unreconciled,
    locked: pending || unreconciled,
    target:
      snapshot?.context.command?.archived &&
      (snapshot.matches("confirming") || pending)
        ? snapshot.context.command.agent
        : null,
    error: snapshot?.context.error ?? "",
    request: (agent: AgentProfile) =>
      owner.current?.actor.send({
        type: "REQUEST",
        agent,
        archived: agent.status === "active",
      }),
    confirm: () => owner.current?.actor.send({ type: "CONFIRM" }),
    dismiss: () => owner.current?.actor.send({ type: "DISMISS" }),
    reconcile: () => owner.current?.actor.send({ type: "RECONCILE" }),
  }
}
