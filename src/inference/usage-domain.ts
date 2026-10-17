import { Schema } from "effect"

import { ResolvedRoute } from "./policy"

export const Attempt = Schema.Struct({
  id: Schema.String,
  turnId: Schema.NullOr(Schema.String),
  route: ResolvedRoute,
  purpose: Schema.String,
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  outcome: Schema.Literals([
    "running",
    "completed",
    "failed",
    "incomplete",
    "interrupted",
    "cancelled",
  ]),
  error: Schema.NullOr(Schema.String),
  reportedModel: Schema.NullOr(Schema.String),
  input: Schema.NullOr(Schema.Number),
  cached: Schema.NullOr(Schema.Number),
  output: Schema.NullOr(Schema.Number),
})
export type Attempt = typeof Attempt.Type
export type TerminalOutcome = Exclude<Attempt["outcome"], "running">
export const InferenceActivity = Schema.Struct({
  attempts: Schema.Array(Attempt),
})
export const UsageReport = Schema.Struct({
  id: Schema.String,
  model: Schema.String,
  input: Schema.Number,
  cached: Schema.Number,
  output: Schema.Number,
})
export type UsageReport = typeof UsageReport.Type
export const UsageTotals = Schema.Struct({
  modelRequests: Schema.Number,
  usageReportedRequests: Schema.Number,
  knownInputTokens: Schema.Number,
  knownCachedInputTokens: Schema.Number,
  knownOutputTokens: Schema.Number,
})
export type UsageTotals = typeof UsageTotals.Type
export const AccountUsage = Schema.Struct({
  input: Schema.Number,
  cached: Schema.Number,
  output: Schema.Number,
  requests: Schema.Number,
})
export type AccountUsage = typeof AccountUsage.Type

export const recordUsage = (
  attempt: Attempt,
  report: UsageReport
): Attempt => ({
  ...attempt,
  reportedModel: report.model,
  input: report.input,
  cached: report.cached,
  output: report.output,
})

export function finishAttempt(
  attempt: Attempt,
  outcome: TerminalOutcome,
  error: string | null,
  at: string
): Attempt | undefined {
  return attempt.outcome === "running"
    ? { ...attempt, outcome, error, finishedAt: at }
    : undefined
}

export const restartError =
  "Runtime restarted before a terminal provider event was recorded. Usage may be unreported."

export class UsageStorageError extends Schema.TaggedError<UsageStorageError>()(
  "UsageStorageError",
  { operation: Schema.String }
) {}
