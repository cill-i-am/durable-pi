import { Effect } from "effect"

import type { RuntimeStatus } from "../conversations/status"
import { preserveFatal, observeCleanup } from "../shared/effect"
import type { AgentRuntimeUnavailable, AgentProfile } from "./domain"

export function agentStatuses<TRequirements>(
  agents: readonly AgentProfile[],
  read: (
    agent: AgentProfile
  ) => Effect.Effect<RuntimeStatus, AgentRuntimeUnavailable, TRequirements>
) {
  return Effect.gen(function* () {
    const values = new Map<string, RuntimeStatus>()
    yield* Effect.all(
      agents
        .filter((agent) => agent.status === "active")
        .map((agent) =>
          read(agent).pipe(
            preserveFatal,
            Effect.catchTag("AgentRuntimeUnavailable", () =>
              Effect.succeed(undefined)
            ),
            Effect.tap((status) =>
              Effect.sync(() => {
                if (status) values.set(agent.id, status)
              })
            )
          )
        ),
      { concurrency: 4 }
    ).pipe((timed) =>
      observeCleanup(timed, (observed) =>
        observed.pipe(
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.void,
          })
        )
      )
    )
    return {
      statuses: agents.map((agent) => ({
        agentId: agent.id,
        ...(agent.status === "archived"
          ? { state: "archived" as const, turnId: null }
          : (values.get(agent.id) ?? {
              state: "unavailable" as const,
              turnId: null,
            })),
      })),
    }
  }).pipe(Effect.withSpan("Agents.statuses"))
}
