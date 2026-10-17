import { eq } from "drizzle-orm"
import { alias } from "drizzle-orm/sqlite-core"
import { Effect, Schema } from "effect"

import { chatActivity, chatTurns } from "../../conversations/adapters/schema"
import { TimelineItem, TurnOrigin } from "../../conversations/contracts"
import { RecoveryStateRecord } from "../../conversations/recovery"
import { coalesce } from "../../storage/expressions"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import {
  ActivityStorageError,
  type ActivityRecords,
  type ConversationRecord,
} from "../records"
import { readRunRecords } from "./run-sqlite"
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
  conversation(
    id: string
  ): Effect.Effect<ConversationRecord | null, ActivityStorageError> {
    const root = alias(chatTurns, "activity_root")
    const rootId = coalesce<string>(chatTurns.parent_id, chatTurns.id)
    return mapSqliteError(
      this.db.use((orm) =>
        orm
          .select({
            id: chatTurns.id,
            rootId,
            text: chatTurns.text,
            answer: chatTurns.answer,
            status: chatTurns.status,
            error: chatTurns.error,
            origin: chatTurns.origin,
            recovery: root.recovery,
            payload: chatActivity.payload,
          })
          .from(chatTurns)
          .leftJoin(root, eq(root.id, rootId))
          .leftJoin(chatActivity, eq(chatActivity.turn_id, chatTurns.id))
          .where(eq(chatTurns.id, id))
          .get()
      ),
      (cause) => new ActivityStorageError({ cause })
    ).pipe(
      Effect.map((raw) => {
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
            : Schema.decodeUnknownSync(
                Schema.fromJsonString(RecoveryStateRecord)
              )(row.recovery).view
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
      })
    )
  }
}
