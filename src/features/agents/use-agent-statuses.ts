import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { AgentStatuses, type AgentProfile } from "@/agents/contracts"
import type { RuntimeStatus } from "@/conversations/status"
import { api } from "@/http/client"

import { makeAgentStatuses } from "./agent-statuses-owner"

const noStatuses: Record<string, RuntimeStatus> = {}

export function useAgentStatuses(
  agents: readonly AgentProfile[],
  ownerId: string,
  selectedId?: string
) {
  const [observed, setObserved] = useState<{
    ownerId: string
    saved: Record<string, RuntimeStatus>
  } | null>(null)
  const membership = agents
    .map((agent) => `${agent.id}:${agent.status}`)
    .join(",")
  const members = useRef(membership)
  members.current = membership
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeAgentStatuses>
  > | null>(null)
  const [live, publishLive] = useState<{
    ownerId: string
    agentId: string
    status: RuntimeStatus
  } | null>(null)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeAgentStatuses({
          read: async (signal) =>
            Schema.decodeUnknownSync(AgentStatuses)(
              await api("/api/agent/bots/statuses", undefined, signal)
            ),
          membership: () => members.current,
          visible: () => !document.hidden,
          listen: (inspect) => {
            document.addEventListener("visibilitychange", inspect)
            return () =>
              document.removeEventListener("visibilitychange", inspect)
          },
        })
        owner.current = current
        const update = () => {
          if (mounted)
            setObserved({
              ownerId,
              saved: Object.fromEntries(
                current.actor
                  .getSnapshot()
                  .context.statuses.map(({ agentId, ...status }) => [
                    agentId,
                    status,
                  ])
              ),
            })
        }
        yield* Effect.acquireRelease(
          Effect.sync(() => current.actor.subscribe(update)),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        update()
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
  }, [ownerId])
  useEffect(() => owner.current?.inspect(), [membership])
  const saved = observed?.ownerId === ownerId ? observed.saved : noStatuses
  const statuses = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => [
          agent.id,
          agent.status === "archived"
            ? { state: "archived" as const, turnId: null }
            : live &&
                live.ownerId === ownerId &&
                live.agentId === selectedId &&
                agent.id === selectedId
              ? live.status
              : (saved[agent.id] ?? {
                  state: "unavailable" as const,
                  turnId: null,
                }),
        ])
      ),
    [agents, saved, live, selectedId, ownerId]
  )
  const setLive = useCallback(
    (value: { agentId: string; status: RuntimeStatus }) =>
      publishLive({ ...value, ownerId }),
    [ownerId]
  )
  return { statuses, setLive }
}
