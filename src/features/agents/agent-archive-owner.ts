import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import { agentArchiveMachine, type AgentArchive } from "./agent-archive.machine"
import { makeAgentRequests } from "./agent-requests"

export function makeAgentArchive(work: {
  write: (command: AgentArchive, signal: AbortSignal) => Promise<void>
  reconcile: (command: AgentArchive, signal: AbortSignal) => Promise<void>
}) {
  return Effect.gen(function* () {
    const requests = yield* makeAgentRequests()
    const actor = yield* createEffectActor(
      agentArchiveMachine({
        write: (command) =>
          requests.request((signal) => work.write(command, signal)),
        reconcile: (command) =>
          requests.request((signal) => work.reconcile(command, signal)),
      })
    )
    return { actor, revoke: requests.revoke }
  })
}
