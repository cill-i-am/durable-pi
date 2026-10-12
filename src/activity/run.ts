import { Schema } from "effect"
import type { Sqlite } from "../storage/sqlite"
import { Attempt, type InferenceUsage } from "../inference/usage"
import { RecoveryView } from "../conversations/recovery"

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
  totals: Schema.Struct({
    modelRequests: Schema.Number,
    usageReportedRequests: Schema.Number,
    knownInputTokens: Schema.Number,
    knownCachedInputTokens: Schema.Number,
    knownOutputTokens: Schema.Number,
  }),
  events: Schema.Array(RunEvent),
  next: Schema.NullOr(RunCursor),
})
export type RunActivity = typeof RunActivity.Type
export const RUN_PAGE_SIZE = 50

/** Authenticated bot-local, read-only projection. No telemetry or scheduler calls.
 * Stable keyset pages include all records, not just the latest model-activity page.
 */
export function runActivity(
  db: Sqlite,
  botId: string,
  runId: string,
  usage: InferenceUsage,
  cursor: RunCursor | null = null
): RunActivity | null {
  const turn = db.all<{
    id: string
    status: string
    session_id: string | null
    created_at: string
    started_at: string | null
    finished_at: string | null
  }>(
    "SELECT id,status,session_id,created_at,started_at,finished_at FROM chat_turns WHERE id=? AND parent_id IS NULL",
    runId
  )[0]
  if (!turn) return null
  type Fact = {
    key: string
    at: string
    kind: RunEvent["kind"]
    reference: string
    payload: string
  }
  const rows = db.all<Fact>(
    `
    WITH facts AS (
      SELECT json_extract(value,'$.key') AS key, json_extract(value,'$.at') AS at,
        'run' AS kind, t.id AS reference, value AS payload
      FROM chat_turns t, json_each(json_array(
        json_object('key','accepted:'||t.id,'at',t.created_at,'title','Request accepted','status','accepted'),
        json_object('key','started:'||t.id,'at',t.started_at,'title','Pi session started','status','started'),
        json_object('key','stopped:'||t.id,'at',t.stopped_at,'title','Stop requested','status','stopping'),
        json_object('key','finished:'||t.id,'at',t.finished_at,'title','Run ended','status',t.status)
      )) WHERE t.id=? AND json_extract(value,'$.at') IS NOT NULL
      UNION ALL
      SELECT 'steer:'||id,created_at,'steering',id,json_object('title','Steering accepted','status',delivery)
      FROM chat_turns WHERE parent_id=?
      UNION ALL
      SELECT 'model:'||id,json_extract(payload,'$.startedAt'),'model',id,payload
      FROM inference_attempts WHERE json_extract(payload,'$.turnId')=?
      UNION ALL
      SELECT 'tool:'||id,strftime('%Y-%m-%dT%H:%M:%fZ',createdAt/1000.0,'unixepoch'),'tool',id,
        json_object('title',tool,'status',status,'expiresAt',expiresAt,'isError',
          CASE WHEN json_valid(result) THEN json_extract(result,'$.isError') ELSE NULL END)
      FROM tool_operations WHERE turnId=?
      UNION ALL
      SELECT 'recovery:'||id,at,'recovery',CAST(id AS TEXT),view
      FROM chat_recovery_history WHERE turn_id=?
    ) SELECT * FROM facts WHERE (? IS NULL OR at<? OR (at=? AND key<?))
      ORDER BY at DESC,key DESC LIMIT ?`,
    runId,
    runId,
    runId,
    runId,
    runId,
    cursor?.at ?? null,
    cursor?.at ?? null,
    cursor?.at ?? null,
    cursor?.key ?? null,
    RUN_PAGE_SIZE + 1
  )
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
      const attempt = Schema.decodeUnknownSync(Attempt)(JSON.parse(row.payload))
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
      const view = Schema.decodeUnknownSync(RecoveryView)(
        JSON.parse(row.payload)
      )
      return {
        ...base,
        title: "Tool recovery",
        status: view.phase,
        detail: view.detail,
        reference: String(view.receiptId ?? view.resultId),
      }
    }
    const payload = Schema.decodeUnknownSync(
      Schema.Struct({
        title: Schema.String,
        status: Schema.String,
        expiresAt: Schema.optional(Schema.Number),
        isError: Schema.optional(Schema.NullOr(Schema.Number)),
      })
    )(JSON.parse(row.payload))
    if (row.kind === "tool") {
      const transitions = db.all<typeof Transition.Type>(
        "SELECT status,at FROM tool_operation_history WHERE operationId=? ORDER BY id",
        row.reference
      )
      const expired =
        ["pending", "approved"].includes(payload.status) &&
        (payload.expiresAt ?? Infinity) <= Date.now()
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
    totals: usage.totals(runId),
    events,
    next:
      rows.length > RUN_PAGE_SIZE && last
        ? { at: last.at, key: last.key }
        : null,
  }
}
