import type { Sqlite } from "../storage/sqlite"
import {
  ACTIVITY_PAGE_SIZE,
  type ActivityAgent,
  type ActivityEntry,
  type ActivityQuery,
} from "./contracts"

export function activityEntries(
  db: Sqlite,
  agent: ActivityAgent,
  query: ActivityQuery
): ActivityEntry[] {
  type Row = Omit<ActivityEntry, "agent" | "attention" | "running"> & {
    attention: number
    running: number
  }
  const now = Date.now()
  const filter =
    query.filter === "attention"
      ? "attention=1"
      : query.filter === "running"
        ? "running=1"
        : "1=1"
  const rows = db.all<Row>(
    `
    WITH facts AS (
      SELECT 'turn:'||t.id AS local_key, t.created_at AS at,
        CASE WHEN t.parent_id IS NOT NULL THEN 'steer' ELSE 'conversation' END AS kind,
        CASE WHEN t.origin IS NOT NULL THEN 'Background findings' ELSE substr(t.text,1,180) END AS title,
        CASE WHEN t.status IN ('stopping','cancelled') THEN t.status
          WHEN json_extract(t.recovery,'$.view.phase')='blocked' THEN 'blocked'
          WHEN t.status IN ('preparing','running') AND json_extract(t.recovery,'$.view.phase')='recovering' THEN 'recovering'
          ELSE t.status END AS status,
        t.status='failed' AND NOT EXISTS (SELECT 1 FROM chat_turns r WHERE json_extract(r.creation,'$.retryOf')=t.id) AS attention,
        t.status IN ('queued','preparing','running','stopping') AS running,
        'conversation' AS target, coalesce(t.parent_id,t.id) AS reference
      FROM chat_turns t
      UNION ALL
      SELECT 'tool:'||id, strftime('%Y-%m-%dT%H:%M:%fZ',createdAt/1000.0,'unixepoch'), 'tool', tool,
        CASE WHEN status IN ('pending','approved') AND expiresAt<=? THEN 'expired' ELSE status END,
        status='pending' AND expiresAt>?, status='running', 'conversation', turnId FROM tool_operations
      UNION ALL
      SELECT 'background:'||id, strftime('%Y-%m-%dT%H:%M:%fZ',json_extract(handoff,'$.createdAt')/1000.0,'unixepoch'),
        'background', substr(json_extract(handoff,'$.input.objective'),1,180), status,
        status='paused', status IN ('pending','running','ready'), 'background', CAST(id AS TEXT) FROM background_handoffs
    ), entries AS (SELECT ?||local_key AS key, at, kind, title, status, attention, running, target, reference FROM facts)
    SELECT * FROM entries WHERE ${filter}
      AND (? IS NULL OR at<? OR (at=? AND key<?))
    ORDER BY at DESC,key DESC LIMIT ?`,
    now,
    now,
    `${agent.id}:`,
    query.cursor?.at ?? null,
    query.cursor?.at ?? null,
    query.cursor?.at ?? null,
    query.cursor?.key ?? null,
    ACTIVITY_PAGE_SIZE + 1
  )
  return rows.map((row) => ({
    ...row,
    agent,
    attention: !!row.attention,
    running: !!row.running,
  }))
}
