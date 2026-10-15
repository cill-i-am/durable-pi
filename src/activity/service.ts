import { Cause, Clock, Context, Effect, Layer, Schema } from "effect"
import type { AgentProfile } from "../agents/domain"
import type { UsageTotals } from "../inference/usage-domain"
import type {
  ActivityAgent,
  ActivityConversation,
  ActivityQuery,
} from "./contracts"
import {
  ActivityStorageError,
  ActivityUnavailable,
  type ActivityRecords,
} from "./records"
import { projectRunActivity, type RunCursor } from "./run"

export interface ActivitySources {
  readonly profiles: () => Effect.Effect<
    readonly AgentProfile[],
    ActivityUnavailable
  >
  readonly pausedSummaries: () => Effect.Effect<number, ActivityUnavailable>
  readonly backupError: () => Effect.Effect<string | null, ActivityUnavailable>
  readonly totals: (
    id: string
  ) => Effect.Effect<UsageTotals, ActivityUnavailable>
}
export class Activity extends Context.Service<
  Activity,
  ReturnType<typeof makeActivity>
>()("durable-pi/activity/Activity") {}
export const activitySource = <T, TError, TRequirements>(
  work: Effect.Effect<T, TError, TRequirements>
) =>
  work.pipe(
    Effect.catchCause((cause) =>
      Effect.failCause(
        Cause.map(cause, (error) => new ActivityUnavailable({ cause: error }))
      )
    )
  )
const read = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const activityStorageError =
        Schema.decodeUnknownOption(ActivityStorageError)(cause)
      if (activityStorageError._tag === "Some")
        return activityStorageError.value
      throw cause
    },
  })
export function makeActivity(
  records: ActivityRecords,
  sources: ActivitySources,
  botId: string
) {
  return {
    agents: Effect.fn("Activity.agents")(function* () {
      return (yield* sources.profiles())
        .filter((agent) => agent.status === "active")
        .map(({ id, name }) => ({ id, name }))
    }),
    snapshot: Effect.fn("Activity.snapshot")(function* (
      agent: ActivityAgent,
      query: ActivityQuery
    ) {
      const issues = []
      if (!query.cursor && query.filter !== "running") {
        const paused = yield* sources.pausedSummaries()
        if (paused)
          issues.push({
            key: `${agent.id}:memory`,
            agent,
            title: "Memory summaries paused",
            detail: `${paused} saved source ranges need a retry. Original messages remain available.`,
            target: "memory" as const,
          })
        const backup = yield* sources.backupError()
        if (backup && backup !== "Backup in progress")
          issues.push({
            key: `${agent.id}:backup`,
            agent,
            title: "Cloud backup pending",
            detail:
              "The last complete backup is retained. Open Memory to inspect its status or export a local copy.",
            target: "memory" as const,
          })
      }
      const at = yield* Clock.currentTimeMillis
      return {
        entries: yield* read(() => records.entries(agent, query, at)),
        issues,
      }
    }),
    conversation: Effect.fn("Activity.conversation")(function* (
      id: string,
      cursor: RunCursor | null = null
    ): Effect.fn.Return<
      ActivityConversation | null,
      ActivityStorageError | ActivityUnavailable
    > {
      const record = yield* read(() => records.conversation(id))
      if (!record) return null
      const { rootId, ...conversation } = record
      const run = yield* read(() => records.run(rootId, cursor))
      if (!run) return conversation
      const totals = yield* sources.totals(rootId),
        at = yield* Clock.currentTimeMillis
      return {
        ...conversation,
        run: projectRunActivity(run, botId, rootId, totals, at),
      }
    }),
  }
}
export const activityApplication = (
  records: ActivityRecords,
  sources: ActivitySources,
  botId: string
) => Layer.succeed(Activity, makeActivity(records, sources, botId))
