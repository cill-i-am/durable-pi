import { Schema } from "effect"

import type { RecoveryView } from "../conversations/recovery"
import { Attempt, UsageTotals } from "../inference/usage-domain"

export const RunCursor = Schema.Struct({
  at: Schema.String.check(Schema.isMaxLength(40)),
  key: Schema.String.check(Schema.isMaxLength(300)),
})
export type RunCursor = typeof RunCursor.Type
const Transition = Schema.Struct({
  status: Schema.String,
  at: Schema.Number,
})
export const RunEvent = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  kind: Schema.Literals(["run", "steering", "model", "tool", "recovery"]),
  title: Schema.String,
  status: Schema.String,
  reference: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  detail: Schema.NullOr(Schema.String),
  attempt: Schema.optional(Attempt),
  transitions: Schema.optional(Schema.Array(Transition)),
})
export type RunEvent = typeof RunEvent.Type
export const RunActivity = Schema.Struct({
  botId: Schema.String,
  runId: Schema.String,
  sessionId: Schema.NullOr(Schema.String),
  status: Schema.String,
  createdAt: Schema.String,
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  totals: UsageTotals,
  events: Schema.Array(RunEvent),
  next: Schema.NullOr(RunCursor),
})
export type RunActivity = typeof RunActivity.Type
export const RUN_PAGE_SIZE = 50

export type RunHeader = {
  id: string
  status: string
  session_id: string | null
  created_at: string
  started_at: string | null
  finished_at: string | null
}
type FactBase = { key: string; at: string; reference: string }
export type RunFact =
  | (FactBase & { kind: "model"; attempt: Attempt })
  | (FactBase & { kind: "recovery"; view: typeof RecoveryView.Type })
  | (FactBase & {
      kind: "run" | "steering" | "tool"
      title: string
      status: string
      expiresAt?: number
      isError?: number | null
      transitions?: (typeof Transition.Type)[]
    })
export type RunRecords = { turn: RunHeader; rows: RunFact[] }
export function projectRunActivity(
  records: RunRecords,
  botId: string,
  runId: string,
  totals: UsageTotals,
  now: number
): RunActivity {
  const { turn, rows } = records
  const events = rows.slice(0, RUN_PAGE_SIZE).map((row): RunEvent => {
    const base = {
      key: row.key,
      at: row.at,
      kind: row.kind,
      reference: row.reference,
      finishedAt: null,
      detail: null,
    }
    if (row.kind === "model") {
      const attempt = row.attempt
      return {
        ...base,
        title:
          attempt.purpose === "compaction"
            ? "Working context compaction"
            : attempt.route.model,
        status: attempt.outcome,
        finishedAt: attempt.finishedAt,
        detail: attempt.error,
        attempt,
      }
    }
    if (row.kind === "recovery") {
      const view = row.view
      return {
        ...base,
        title: "Tool recovery",
        status: view.phase,
        detail: view.detail,
        reference: String(view.receiptId ?? view.resultId),
      }
    }
    const payload = row
    if (row.kind === "tool") {
      const transitions = row.transitions ?? []
      const expired =
        ["pending", "approved"].includes(payload.status) &&
        (payload.expiresAt ?? Infinity) <= now
      const uncertain =
        payload.status === "running" &&
        ["done", "failed", "cancelled"].includes(turn.status)
      const last = transitions.at(-1)
      const ended =
        last &&
        ["done", "denied", "cancelled", "expired", "interrupted"].includes(
          last.status
        )
      return {
        ...base,
        title: payload.title,
        status: expired
          ? "expired"
          : uncertain
            ? "unconfirmed"
            : payload.isError
              ? "error"
              : payload.status,
        finishedAt: ended ? new Date(last.at).toISOString() : null,
        transitions,
        detail: uncertain
          ? "Dispatch was recorded, but no terminal receipt is available. Check the saved result before another attempt."
          : null,
      }
    }
    return { ...base, title: payload.title, status: payload.status }
  })
  const last = events.at(-1)
  return {
    botId,
    runId,
    sessionId: turn.session_id,
    status: turn.status,
    createdAt: turn.created_at,
    startedAt: turn.started_at,
    finishedAt: turn.finished_at,
    totals,
    events,
    next:
      rows.length > RUN_PAGE_SIZE && last
        ? { at: last.at, key: last.key }
        : null,
  }
}
