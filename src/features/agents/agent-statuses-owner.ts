import { createEffectActor } from "@xstate/effect"
import { Effect } from "effect"

import type { AgentStatuses } from "@/agents/contracts"

import { makeAgentRequests } from "./agent-requests"
import { agentStatusesMachine } from "./agent-statuses.machine"

export function makeAgentStatuses(ports: {
  read: (signal: AbortSignal) => Promise<typeof AgentStatuses.Type>
  membership: () => string
  visible: () => boolean
  listen: (inspect: () => void) => () => void
}) {
  return Effect.gen(function* () {
    const requests = yield* makeAgentRequests()
    const actor = yield* createEffectActor(
      agentStatusesMachine(requests.request(ports.read)),
      { input: { membership: ports.membership(), visible: ports.visible() } }
    )
    const inspect = () => {
      if (requests.active())
        actor.send({
          type: "OBSERVE",
          membership: ports.membership(),
          visible: ports.visible(),
        })
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => ports.listen(inspect)),
      (stop) => Effect.sync(stop)
    )
    inspect()
    return { actor, inspect, revoke: requests.revoke }
  })
}
