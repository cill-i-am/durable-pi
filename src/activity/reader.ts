import { Effect } from "effect"
import { observeCleanup } from "../shared/effect"
import type { AgentId } from "../agents/domain"
import type {
  ActivityAgent,
  ActivityConversation,
  ActivityQuery,
  ActivitySnapshot,
} from "./contracts"
import { activityFeed } from "./feed"
import { ActivityUnavailable } from "./records"
import type { RunCursor } from "./run"

export interface ActivityDirectory {
  readonly agents: () => Effect.Effect<
    readonly ActivityAgent[],
    ActivityUnavailable
  >
  readonly find: (
    id: AgentId
  ) => Effect.Effect<ActivityAgent | null, ActivityUnavailable>
  readonly connected: () => Effect.Effect<boolean, ActivityUnavailable>
  readonly snapshot: (
    agent: ActivityAgent,
    query: ActivityQuery
  ) => Effect.Effect<ActivitySnapshot, ActivityUnavailable>
  readonly conversation: (
    agent: ActivityAgent,
    id: string,
    cursor: RunCursor | null
  ) => Effect.Effect<ActivityConversation | null, ActivityUnavailable>
}
const bounded = <T>(work: Effect.Effect<T, ActivityUnavailable>) =>
  observeCleanup(work, (observed) =>
    observed.pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () =>
          Effect.fail(
            new ActivityUnavailable({ cause: "Activity read timed out" })
          ),
      })
    )
  )
export const activityOverview = Effect.fn("Activity.overview")(function* (
  directory: ActivityDirectory,
  selectedId: AgentId,
  scope: "bot" | "all",
  query: ActivityQuery
) {
  const selected =
    scope === "bot" ? yield* bounded(directory.find(selectedId)) : null
  if (scope === "bot" && !selected) return null
  const agents = selected ? [selected] : yield* bounded(directory.agents())
  const showConnection =
    !query.cursor && query.filter !== "running" && !!agents[0]
  const [page, connected] = yield* Effect.zip(
    activityFeed(agents, query, directory.snapshot),
    showConnection ? bounded(directory.connected()) : Effect.succeed(true),
    { concurrent: true }
  )
  return connected
    ? page
    : {
        ...page,
        issues: [
          {
            key: "account:model",
            agent: agents[0]!,
            title: "ChatGPT connection unavailable",
            detail:
              "Reconnect the existing subscription connection before sending new requests. Saved work is retained; no API-key fallback is used.",
            target: "models" as const,
          },
          ...page.issues,
        ],
      }
})
export const activityRecord = Effect.fn("Activity.record")(function* (
  directory: ActivityDirectory,
  selectedId: AgentId,
  id: string,
  cursor: RunCursor | null
) {
  const agent = yield* bounded(directory.find(selectedId))
  return agent
    ? yield* bounded(directory.conversation(agent, id, cursor))
    : null
})
