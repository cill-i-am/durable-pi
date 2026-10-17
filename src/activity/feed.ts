import { Effect } from "effect"

import { preserveFatal, observeCleanup } from "../shared/effect"
import {
  activityPage,
  type ActivityAgent,
  type ActivityQuery,
  type ActivitySnapshot,
} from "./contracts"
import type { ActivityUnavailable } from "./records"

export function activityFeed<TRequirements>(
  agents: readonly ActivityAgent[],
  query: ActivityQuery,
  read: (
    agent: ActivityAgent,
    query: ActivityQuery
  ) => Effect.Effect<ActivitySnapshot, ActivityUnavailable, TRequirements>
) {
  return Effect.gen(function* () {
    const snapshots = new Map<string, ActivitySnapshot>()
    yield* Effect.all(
      agents.map((agent) =>
        read(agent, query).pipe(
          preserveFatal,
          Effect.catchTag("ActivityUnavailable", () =>
            Effect.succeed(undefined)
          ),
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              if (snapshot) snapshots.set(agent.id, snapshot)
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
    return activityPage(
      [...snapshots.values()],
      agents.filter((agent) => !snapshots.has(agent.id))
    )
  })
}
