import { Effect } from "effect"
import type { AgentProfile } from "./domain"
import type { RuntimeStatus } from "../conversations/status"

/** Only the authenticated owner's catalog admits reads; unavailable bots stay visible. */
export function agentStatuses(
  agents: readonly AgentProfile[],
  read: (agent: AgentProfile) => Promise<RuntimeStatus>
) {
  return Effect.gen(function* () {
    const values = new Map<string, RuntimeStatus>()
    yield* Effect.all(
      agents.map((agent) =>
        agent.status === "archived"
          ? Effect.sync(() => {
              values.set(agent.id, { state: "archived", turnId: null })
            })
          : Effect.tryPromise({
              try: () => read(agent),
              catch: () => undefined,
            }).pipe(
              Effect.match({
                onSuccess: (status) => {
                  values.set(agent.id, status)
                },
                onFailure: () => {},
              })
            )
      ),
      { concurrency: 4 }
    ).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void })
    )
    return {
      statuses: agents.map((agent) => ({
        agentId: agent.id,
        ...(values.get(agent.id) ?? {
          state: "unavailable" as const,
          turnId: null,
        }),
      })),
    }
  })
}
