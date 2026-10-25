import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import type { AgentId, AgentProfile } from "@/agents/contracts"

import { agentEditorMachine, type AgentSave } from "./agent-editor.machine"
import { makeAgentRequests } from "./agent-requests"

export function makeAgentEditor(
  input: { id: AgentId; agent: AgentProfile | null },
  work: {
    save: (input: AgentSave, signal: AbortSignal) => Promise<AgentProfile>
    reconcile: (profile: AgentProfile, signal: AbortSignal) => Promise<void>
    close: () => void
  }
) {
  return Effect.gen(function* () {
    const requests = yield* makeAgentRequests()
    const actor = yield* createEffectActor(
      agentEditorMachine({
        save: (input) => requests.request((signal) => work.save(input, signal)),
        reconcile: (profile) =>
          requests.request((signal) => work.reconcile(profile, signal)),
        close: Effect.sync(() => {
          if (requests.active()) work.close()
        }),
      }),
      { input }
    )
    return { actor, revoke: requests.revoke }
  })
}
