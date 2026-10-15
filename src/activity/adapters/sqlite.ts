import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { TimelineItem, TurnOrigin } from "../../conversations/contracts"
import { RecoveryStateRecord } from "../../conversations/recovery"
import type { ActivityRecords, ConversationRecord } from "../records"
import { activityRows, readRunRecords } from "./run-sqlite"
import { activityEntries } from "./sqlite-entries"

const ConversationRow = Schema.Struct({
  id: Schema.String,
  rootId: Schema.String,
  text: Schema.String,
  answer: Schema.String,
  status: Schema.String,
  error: Schema.NullOr(Schema.String),
  origin: Schema.NullOr(Schema.String),
  recovery: Schema.NullOr(Schema.String),
  payload: Schema.NullOr(Schema.String),
})
export class SqliteActivityRecords implements ActivityRecords {
  constructor(private readonly db: Sqlite) {}
  entries: ActivityRecords["entries"] = (agent, query, now) =>
    activityEntries(this.db, agent, query, now)
  run: ActivityRecords["run"] = (id, cursor) =>
    readRunRecords(this.db, id, cursor)
  conversation(id: string): ConversationRecord | null {
    const raw = activityRows(this.db)<unknown>(
      `SELECT t.id,coalesce(t.parent_id,t.id) AS rootId,t.text,t.answer,t.status,t.error,t.origin,r.recovery,a.payload
      FROM chat_turns t LEFT JOIN chat_turns r ON r.id=coalesce(t.parent_id,t.id) LEFT JOIN chat_activity a ON a.turn_id=t.id WHERE t.id=?`,
      id
    )[0]
    if (raw === undefined) return null
    const row = Schema.decodeUnknownSync(ConversationRow)(raw)
    const origin =
      row.origin === null
        ? null
        : Schema.decodeUnknownSync(Schema.fromJsonString(TurnOrigin))(
            row.origin
          )
    const recovery =
      row.recovery === null
        ? null
        : Schema.decodeUnknownSync(Schema.fromJsonString(RecoveryStateRecord))(
            row.recovery
          ).view
    const activity =
      row.payload === null
        ? []
        : Schema.decodeUnknownSync(
            Schema.fromJsonString(Schema.Array(TimelineItem))
          )(row.payload)
    return {
      rootId: row.rootId,
      id: row.id,
      source: origin ? "background" : "user",
      text: row.text,
      answer: row.answer,
      status: row.status,
      error: row.error,
      recovery,
      activity,
    }
  }
}
