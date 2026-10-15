import { Effect, Layer, Schema } from "effect"
import { TimelineItem } from "../contracts"
import type { Sqlite } from "../../storage/sqlite"
import type { MemoryLedger } from "../../memory/ledger"
import type { ConversationLedger } from "../ledger"
import {
  ConversationJournal,
  makeConversationJournal,
  type ConversationMaterialization,
} from "../journal"
import { ConversationStorageError } from "../turns"

export function sqliteConversationMaterialization(
  db: Sqlite
): ConversationMaterialization {
  try {
    db.run(
      "CREATE TABLE IF NOT EXISTS chat_activity (turn_id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
    )
  } catch (cause) {
    throw new ConversationStorageError({
      operation: "open materialization",
      cause,
    })
  }
  return {
    ...conversationTransactions(db),
    readActivity: (id) => {
      let row: { payload: string } | undefined
      try {
        row = db.all<{ payload: string }>(
          "SELECT payload FROM chat_activity WHERE turn_id=?",
          id
        )[0]
      } catch (cause) {
        throw new ConversationStorageError({
          operation: "read activity",
          cause,
        })
      }
      return row
        ? Schema.decodeUnknownSync(Schema.Array(TimelineItem))(
            JSON.parse(row.payload)
          )
        : undefined
    },
    saveActivity: (id, activity) => {
      const payload = JSON.stringify(activity)
      try {
        db.run(
          "INSERT INTO chat_activity VALUES (?,?) ON CONFLICT(turn_id) DO UPDATE SET payload=excluded.payload",
          id,
          payload
        )
      } catch (cause) {
        throw new ConversationStorageError({
          operation: "save activity",
          cause,
        })
      }
    },
  }
}
export function conversationTransactions(
  db: Sqlite
): Pick<ConversationMaterialization, "transactionGroup" | "atomic"> {
  return {
    transactionGroup: db,
    atomic: (body) => {
      const callback: { failed: boolean; cause?: unknown } = { failed: false }
      try {
        return db.transaction(() => {
          try {
            return body()
          } catch (cause) {
            callback.failed = true
            callback.cause = cause
            throw cause
          }
        })
      } catch (cause) {
        if (callback.failed && cause === callback.cause) throw cause
        throw new ConversationStorageError({
          operation: "materialization transaction",
          cause,
        })
      }
    },
  }
}
export const sqliteConversationJournal = (
  db: Sqlite,
  conversations: ConversationLedger,
  memory: Pick<MemoryLedger, "transactionGroup" | "append" | "render" | "notes">
) =>
  Layer.effect(
    ConversationJournal,
    Effect.try({
      try: () =>
        makeConversationJournal(
          conversations,
          memory,
          sqliteConversationMaterialization(db)
        ),
      catch: (cause) => {
        const conversationStorageError = Schema.decodeUnknownOption(
          ConversationStorageError
        )(cause)
        if (conversationStorageError._tag === "Some")
          return conversationStorageError.value
        throw cause
      },
    }).pipe(Effect.withSpan("Conversations.sqlite.openJournal"))
  )
