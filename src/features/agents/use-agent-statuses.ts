import { useEffect, useMemo, useState } from "react"
import { Schema } from "effect"
import { AgentStatuses, type AgentProfile } from "@/agents/contracts"
import type { RuntimeStatus } from "@/conversations/status"
import { api } from "@/http/client"
import { poll } from "@/http/poll"

export function useAgentStatuses(
  agents: readonly AgentProfile[],
  ownerId: string,
  selectedId?: string
) {
  const [saved, setSaved] = useState<Record<string, RuntimeStatus>>({})
  const [live, setLive] = useState<{
    agentId: string
    status: RuntimeStatus
  } | null>(null)
  const membership = agents
    .map((agent) => `${agent.id}:${agent.status}`)
    .join(",")
  useEffect(() => {
    if (!membership) return
    const controller = new AbortController()
    const stopped = () => controller.signal.aborted
    let pending = false
    const refresh = async () => {
      if (pending || document.hidden || stopped()) return
      pending = true
      try {
        const result = Schema.decodeUnknownSync(AgentStatuses)(
          await api("/api/agent/bots/statuses", undefined, controller.signal)
        )
        if (!stopped())
          setSaved(
            Object.fromEntries(
              result.statuses.map(({ agentId, ...status }) => [agentId, status])
            )
          )
      } catch {
        if (!stopped()) setSaved({})
      } finally {
        pending = false
      }
    }
    const stop = poll(refresh, 30_000, true)
    const visible = () => {
      void refresh()
    }
    document.addEventListener("visibilitychange", visible)
    return () => {
      controller.abort()
      stop()
      document.removeEventListener("visibilitychange", visible)
    }
  }, [ownerId, membership])
  const statuses = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => [
          agent.id,
          agent.status === "archived"
            ? { state: "archived" as const, turnId: null }
            : live && live.agentId === selectedId && agent.id === selectedId
              ? live.status
              : (saved[agent.id] ?? {
                  state: "unavailable" as const,
                  turnId: null,
                }),
        ])
      ),
    [agents, saved, live, selectedId]
  )
  return { statuses, setLive }
}
