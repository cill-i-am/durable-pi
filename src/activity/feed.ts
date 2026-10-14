import { Effect } from "effect"
import {
  activityPage,
  type ActivityAgent,
  type ActivityQuery,
  type ActivitySnapshot,
} from "./contracts"

export function activityFeed(
  agents: readonly ActivityAgent[],
  query: ActivityQuery,
  read: (
    agent: ActivityAgent,
    query: ActivityQuery
  ) => Promise<ActivitySnapshot>
) {
  return Effect.gen(function* () {
    const snapshots = new Map<string, ActivitySnapshot>()
    yield* Effect.all(
      agents.map((agent) =>
        Effect.tryPromise({
          try: () => read(agent, query),
          catch: () => agent,
        }).pipe(
          Effect.match({
            onSuccess: (snapshot) => {
              snapshots.set(agent.id, snapshot)
            },
            onFailure: () => {},
          })
        )
      ),
      { concurrency: 4 }
    ).pipe(
      Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.void })
    )
    return activityPage(
      [...snapshots.values()],
      agents.filter((agent) => !snapshots.has(agent.id))
    )
  })
}
