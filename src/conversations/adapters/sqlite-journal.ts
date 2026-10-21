import { eq, inArray, sql } from "drizzle-orm"
import { Effect, Layer, Schema } from "effect"

import type { MemoryLedger } from "../../memory/ledger"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { TimelineItem } from "../contracts"
import {
  ConversationJournal,
  makeConversationJournal,
  type ConversationMaterialization,
} from "../journal"
import type { ConversationLedger } from "../ledger"
import { ConversationStorageError } from "../turns"
import { chatActivity } from "./schema"

const decodeActivity = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(TimelineItem))
)

export function conversationTransactions(
  db: Sqlite
): Pick<ConversationMaterialization, "transactionGroup" | "atomic"> {
  return {
    transactionGroup: db,
    atomic: (body) =>
      mapSqliteError(
        db.transaction(body),
        (cause) =>
          new ConversationStorageError({
            operation: "materialization transaction",
            cause,
          })
      ),
  }
}
export function sqliteConversationMaterialization(
  db: Sqlite
): ConversationMaterialization {
  return {
    ...conversationTransactions(db),
    readActivity: (id) =>
      mapSqliteError(
        db.use((orm) =>
          orm
            .select({ payload: chatActivity.payload })
            .from(chatActivity)
            .where(eq(chatActivity.turn_id, id))
            .limit(1)
        ),
        (cause) =>
          new ConversationStorageError({ operation: "read activity", cause })
      ).pipe(
        Effect.map((rows) =>
          rows[0] ? decodeActivity(rows[0].payload) : undefined
        )
      ),
    readActivities: (ids) =>
      ids.length === 0
        ? Effect.succeed(new Map())
        : mapSqliteError(
            db.use((orm) =>
              orm
                .select({
                  id: chatActivity.turn_id,
                  payload: chatActivity.payload,
                })
                .from(chatActivity)
                .where(
                  inArray(
                    chatActivity.turn_id,
                    orm
                      .select({ id: sql<string>`value` })
                      .from(sql`json_each(${JSON.stringify(ids)})`)
                  )
                )
            ),
            (cause) =>
              new ConversationStorageError({
                operation: "read activities",
                cause,
              })
          ).pipe(
            Effect.map(
              (rows) =>
                new Map(
                  rows.map((row) => [row.id, decodeActivity(row.payload)])
                )
            )
          ),
    saveActivity: (id, activity) =>
      mapSqliteError(
        db.use((orm) =>
          orm
            .insert(chatActivity)
            .values({ turn_id: id, payload: JSON.stringify(activity) })
            .onConflictDoUpdate({
              target: chatActivity.turn_id,
              set: { payload: JSON.stringify(activity) },
            })
        ),
        (cause) =>
          new ConversationStorageError({ operation: "save activity", cause })
      ).pipe(Effect.asVoid),
  }
}
export const sqliteConversationJournal = (
  db: Sqlite,
  conversations: ConversationLedger,
  memory: Pick<MemoryLedger, "transactionGroup" | "append" | "render" | "notes">
) =>
  Layer.succeed(
    ConversationJournal,
    makeConversationJournal(
      conversations,
      memory,
      sqliteConversationMaterialization(db)
    )
  )
