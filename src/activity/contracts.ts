import { RunActivity } from "./run"
import { RecoveryView } from "../conversations/recovery"
import { Schema } from "effect"
import { AgentId, AgentName } from "../agents/domain"
import { TimelineItem } from "../conversations/contracts"

export const ActivityFilter = Schema.Literals(["all", "attention", "running"])
export type ActivityFilter = typeof ActivityFilter.Type
export const ActivityTarget = Schema.Literals([
  "conversation",
  "memory",
  "background",
  "models",
])
export type ActivityTarget = typeof ActivityTarget.Type
export const ActivityAgent = Schema.Struct({ id: AgentId, name: AgentName })
export type ActivityAgent = typeof ActivityAgent.Type
export const ActivityCursor = Schema.Struct({
  at: Schema.String.check(
    Schema.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  ),
  key: Schema.String.check(Schema.isMaxLength(300)),
})
export type ActivityCursor = typeof ActivityCursor.Type
export const ActivityEntry = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  agent: ActivityAgent,
  kind: Schema.Literals(["conversation", "steer", "tool", "background"]),
  title: Schema.String,
  status: Schema.String,
  attention: Schema.Boolean,
  running: Schema.Boolean,
  target: ActivityTarget,
  reference: Schema.String,
})
export type ActivityEntry = typeof ActivityEntry.Type
export const ActivityIssue = Schema.Struct({
  key: Schema.String,
  agent: ActivityAgent,
  title: Schema.String,
  detail: Schema.String,
  target: ActivityTarget,
})
export type ActivityIssue = typeof ActivityIssue.Type
export const ActivityPage = Schema.Struct({
  entries: Schema.Array(ActivityEntry),
  issues: Schema.Array(ActivityIssue),
  unavailable: Schema.Array(ActivityAgent),
  next: Schema.NullOr(ActivityCursor),
})
export type ActivityPage = typeof ActivityPage.Type
export type ActivityQuery = {
  filter: ActivityFilter
  cursor: ActivityCursor | null
}
export type ActivitySnapshot = {
  entries: readonly ActivityEntry[]
  issues: readonly ActivityIssue[]
}
export const ActivityConversation = Schema.Struct({
  source: Schema.Literals(["user", "background"]),
  id: Schema.String,
  text: Schema.String,
  answer: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  recovery: Schema.optional(Schema.NullOr(RecoveryView)),
  activity: Schema.Array(TimelineItem),
  run: Schema.optional(RunActivity),
})
export type ActivityConversation = typeof ActivityConversation.Type
export const ACTIVITY_PAGE_SIZE = 40

export function activityQuery(url: URL): ActivityQuery {
  const filter = Schema.decodeUnknownSync(ActivityFilter)(
    url.searchParams.get("filter") ?? "all"
  )
  const cursor = url.searchParams.get("cursor")
  return {
    filter,
    cursor: cursor
      ? Schema.decodeUnknownSync(ActivityCursor)(JSON.parse(cursor))
      : null,
  }
}

export function activityPage(
  snapshots: readonly ActivitySnapshot[],
  unavailable: readonly ActivityAgent[]
): ActivityPage {
  const entries = snapshots
    .flatMap((s) => s.entries)
    .sort((a, b) => {
      const left = a.at === b.at ? a.key : a.at,
        right = a.at === b.at ? b.key : b.at
      return left === right ? 0 : left < right ? 1 : -1
    })
  const page = entries.slice(0, ACTIVITY_PAGE_SIZE)
  const last = page.at(-1)
  return {
    entries: page,
    issues: snapshots.flatMap((s) => s.issues),
    unavailable: [...unavailable],
    next:
      entries.length > ACTIVITY_PAGE_SIZE && last
        ? { at: last.at, key: last.key }
        : null,
  }
}
