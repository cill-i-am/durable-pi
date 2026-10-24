import { createEffectActor } from "@xstate/effect"
import { Effect, Fiber } from "effect"
import { useEffect, useRef, useState } from "react"
import type { SnapshotFrom } from "xstate"

import type { AgentProfile } from "@/agents/contracts"
import type { useConversation } from "@/features/conversation"
import type { SettingsCategory, Workbench } from "@/navigation/workspace"

import { settingsOwnerMachine } from "./settings-owner.machine"
import type { useWorkspaceLocation } from "./use-workspace-location"

type SettingsOwner = {
  agent: AgentProfile
  location: ReturnType<typeof useWorkspaceLocation>
  conversation: ReturnType<typeof useConversation>
  settings: SettingsCategory | null
  workbench: Workbench | null
}
export function useSettingsOwner(view: SettingsOwner | null, shown: boolean) {
  const id = view?.agent.id ?? null
  const latest = useRef({ id, shown })
  latest.current = { id, shown }
  const initial = useRef(latest.current)
  const bodies = useRef(new Map<string, SettingsOwner>())
  const owner = useRef<Effect.Success<
    ReturnType<typeof createEffectActor<typeof settingsOwnerMachine>>
  > | null>(null)
  const [snapshot, setSnapshot] = useState<SnapshotFrom<
    typeof settingsOwnerMachine
  > | null>(null)
  const rendered = snapshot ? snapshot.context.id : initial.current.id
  // Values are current render data, not another progression source. The actor
  // alone selects which owner may remain mounted across route replacement.
  if (view) bodies.current.set(view.agent.id, view)
  for (const key of bodies.current.keys())
    if (key !== rendered && key !== id) bodies.current.delete(key)
  useEffect(() => {
    let mounted = true
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const actor = yield* createEffectActor(settingsOwnerMachine, {
          input: initial.current,
        })
        owner.current = actor
        actor.send({ type: "VIEW", ...latest.current })
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            actor.subscribe((state) => {
              if (mounted) setSnapshot(state)
            })
          ),
          (subscription) => Effect.sync(() => subscription.unsubscribe())
        )
        if (mounted) setSnapshot(actor.getSnapshot())
        return yield* Effect.never
      }).pipe(Effect.scoped)
    )
    return () => {
      mounted = false
      owner.current = null
      Effect.runFork(Fiber.interrupt(fiber))
    }
  }, [])
  useEffect(() => {
    owner.current?.send({ type: "VIEW", id, shown })
  }, [id, shown])
  return {
    view: rendered ? (bodies.current.get(rendered) ?? null) : null,
    retaining: rendered !== null && rendered !== id,
  }
}
