import { Cause, Effect, Exit, Fiber, Schema } from "effect"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import { AgentList, homeAgentId, type AgentId } from "@/agents/contracts"
import { markReady } from "@/features/performance"
import { api } from "@/http/client"

import { makeAgentCatalog } from "./agent-catalog-owner"
import type { agentCatalogMachine } from "./agent-catalog.machine"

export function useAgentCatalog(ownerId: string, selectedId?: string) {
  const owner = useRef<Effect.Success<
    ReturnType<typeof makeAgentCatalog>
  > | null>(null)
  const [live, setLive] = useState<{
    ownerId: string
    snapshot: SnapshotFrom<ReturnType<typeof agentCatalogMachine>>
  } | null>(null)
  const [selected, setSelected] = useState<string>(homeAgentId)
  useEffect(() => {
    try {
      setSelected(localStorage.getItem(`pi:selected:${ownerId}`) ?? homeAgentId)
    } catch {}
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const current = yield* makeAgentCatalog(async (signal) => {
          const result = Schema.decodeUnknownSync(AgentList)(
            await api("/api/agent/bots", undefined, signal)
          )
          if (!signal.aborted) markReady("catalog")
          return result.agents
        })
        owner.current = current
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            current.actor.subscribe((snapshot) => {
              if (mounted) setLive({ ownerId, snapshot })
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setLive({ ownerId, snapshot: current.actor.getSnapshot() })
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
  const state = live?.ownerId === ownerId ? live.snapshot.context : null
  const agents = useMemo(() => [...(state?.agents ?? [])], [state?.agents])
  const refresh = useCallback(
    (signal?: AbortSignal) =>
      owner.current
        ? Effect.runPromise(owner.current.refresh(), { signal })
        : Promise.reject(new Error("Agent catalog is opening.")),
    []
  )
  useEffect(() => {
    const agent = agents.find(
      (agent) =>
        (agent.id === selectedId || agent.slug === selectedId) &&
        agent.status === "active"
    )
    if (!agent) return
    try {
      localStorage.setItem(`pi:selected:${ownerId}`, agent.id)
    } catch {}
  }, [selectedId, ownerId, agents])
  const select = (id: AgentId) => {
    setSelected(id)
    try {
      localStorage.setItem(`pi:selected:${ownerId}`, id)
    } catch {}
  }
  return {
    agents,
    loading: state?.loading ?? true,
    error: state?.error ?? "",
    refresh,
    select,
    selected: selectedId
      ? agents.find(
          (agent) => agent.id === selectedId || agent.slug === selectedId
        )
      : (agents.find(
          (agent) => agent.id === selected && agent.status === "active"
        ) ?? agents.find((agent) => agent.id === homeAgentId)),
  }
}
