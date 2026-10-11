import { Effect } from "effect"
import {
  activityPage,
  type ActivityAgent,
  type ActivityQuery,
  type ActivitySnapshot,
} from "./contracts"

/** An owner-catalog projection. Failed bots remain visible; reads grant no execution authority. */
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
    // RPC promises cannot be cancelled. One deadline stops further admission;
    // per-call timeouts would free slots while their RPCs were still pending.
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
