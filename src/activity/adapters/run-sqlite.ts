import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { ActivityStorageError } from "../records"
import { Attempt } from "../../inference/usage-domain"
import { RecoveryView } from "../../conversations/recovery"
import {
  RUN_PAGE_SIZE,
  type RunCursor,
  type RunFact,
  type RunHeader,
  type RunRecords,
} from "../run"

const Header = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  session_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  started_at: Schema.NullOr(Schema.String),
  finished_at: Schema.NullOr(Schema.String),
})
const FactRow = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  kind: Schema.Literals(["run", "steering", "model", "tool", "recovery"]),
  reference: Schema.String,
  payload: Schema.String,
})
type RawFact = typeof FactRow.Type
const Payload = Schema.Struct({
  title: Schema.String,
  status: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
  isError: Schema.optional(Schema.NullOr(Schema.Number)),
})
const Transition = Schema.Struct({ status: Schema.String, at: Schema.Number })
/** Only driver calls are converted. Bad historical rows remain defects. */
export const activityRows =
  (db: Sqlite) =>
  <T>(query: string, ...bindings: (string | number | null)[]): T[] => {
    try {
      return db.all<T>(query, ...bindings)
    } catch (cause) {
      throw new ActivityStorageError({ cause })
    }
  }
export function readRunRecords(
  db: Sqlite,
  runId: string,
  cursor: RunCursor | null
): RunRecords | null {
  const read = activityRows(db)
  const turn = read<RunHeader>(
    "SELECT id,status,session_id,created_at,started_at,finished_at FROM chat_turns WHERE id=? AND parent_id IS NULL",
    runId
  )[0]
  if (!turn) return null
  const rows = read<RawFact>(
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
  return {
    turn: Schema.decodeUnknownSync(Header)(turn),
    rows: rows.map((raw): RunFact => {
      const row = Schema.decodeUnknownSync(FactRow)(raw)
      const base = { key: row.key, at: row.at, reference: row.reference }
      if (row.kind === "model")
        return {
          ...base,
          kind: "model",
          attempt: Schema.decodeUnknownSync(Schema.fromJsonString(Attempt))(
            row.payload
          ),
        }
      if (row.kind === "recovery")
        return {
          ...base,
          kind: "recovery",
          view: Schema.decodeUnknownSync(Schema.fromJsonString(RecoveryView))(
            row.payload
          ),
        }
      const payload = Schema.decodeUnknownSync(Schema.fromJsonString(Payload))(
        row.payload
      )
      return {
        ...base,
        kind: row.kind,
        ...payload,
        ...(row.kind === "tool"
          ? {
              transitions: read<unknown>(
                "SELECT status,at FROM tool_operation_history WHERE operationId=? ORDER BY id",
                row.reference
              ).map((transition) =>
                Schema.decodeUnknownSync(Transition)(transition)
              ),
            }
          : {}),
      }
    }),
  }
}
