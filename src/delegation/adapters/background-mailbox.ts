import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { BackgroundHandoff } from "../background"
import { Handoff } from "../background-domain"
import {
  BackgroundStorageError,
  type BackgroundLedger,
} from "../background-ledger"

const Row = Schema.Struct({
  ...Handoff.fields,
  handoff: Schema.fromJsonString(BackgroundHandoff),
})
const restore = (raw: unknown): Handoff => {
  const row = Schema.decodeUnknownSync(Row)(raw)
  if (row.id !== row.handoff.id || row.turn_id !== row.handoff.turnId)
    throw new Error(
      "Stored background handoff identity does not match its row."
    )
  if (row.status === "ready" && row.report === null)
    throw new Error("Ready background handoff has no report.")
  return row
}

/** Native SQLite mechanics and codecs only; decisions live in the application. */
export class SqliteBackgroundMailbox implements BackgroundLedger {
  readonly transactionGroup: object
  private readonly sql: Sqlite
  constructor(db: Sqlite) {
    this.transactionGroup = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new BackgroundStorageError({ operation, cause })
      }
    }
    this.sql = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        let callbackFailure: { cause: unknown } | undefined
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              callbackFailure = { cause }
              throw cause
            }
          })
        } catch (cause) {
          if (callbackFailure && cause === callbackFailure.cause) throw cause
          throw new BackgroundStorageError({ operation: "transaction", cause })
        }
      },
    }
    this.sql.run(
      "CREATE TABLE IF NOT EXISTS background_handoffs (id INTEGER PRIMARY KEY,turn_id TEXT NOT NULL UNIQUE,handoff TEXT NOT NULL,status TEXT NOT NULL,report TEXT,error TEXT,failures INTEGER NOT NULL DEFAULT 0,next_at INTEGER)"
    )
    this.sql.run(
      "CREATE TABLE IF NOT EXISTS background_retries (operation_id TEXT PRIMARY KEY,group_id INTEGER NOT NULL)"
    )
  }
  atomic<T>(body: () => T) {
    return this.sql.transaction(body)
  }
  get(id: number) {
    const row = this.sql.all<unknown>(
      "SELECT * FROM background_handoffs WHERE id=?",
      id
    )[0]
    return row === undefined ? undefined : restore(row)
  }
  list(offset: number) {
    return this.sql
      .all<unknown>(
        "SELECT * FROM background_handoffs ORDER BY id DESC LIMIT 20 OFFSET ?",
        offset
      )
      .map(restore)
  }
  unfinished() {
    return this.sql
      .all<unknown>(
        "SELECT * FROM background_handoffs WHERE status IN ('pending','running','ready','paused') ORDER BY id"
      )
      .map(restore)
  }
  hasTurn(turnId: string) {
    return (
      this.sql.all("SELECT id FROM background_handoffs WHERE turn_id=?", turnId)
        .length > 0
    )
  }
  put(row: Handoff) {
    // Validate application writes before entering driver error conversion.
    restore({ ...row, handoff: JSON.stringify(row.handoff) })
    this.sql.run(
      "INSERT INTO background_handoffs (id,turn_id,handoff,status,report,error,failures,next_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,report=excluded.report,error=excluded.error,failures=excluded.failures,next_at=excluded.next_at",
      row.id,
      row.turn_id,
      JSON.stringify(row.handoff),
      row.status,
      row.report,
      row.error,
      row.failures,
      row.next_at
    )
  }
  retry(operationId: string) {
    const row = this.sql.all<unknown>(
      "SELECT group_id FROM background_retries WHERE operation_id=?",
      operationId
    )[0]
    return row === undefined
      ? undefined
      : Schema.decodeUnknownSync(
          Schema.Struct({ group_id: BackgroundHandoff.fields.id })
        )(row).group_id
  }
  putRetry(operationId: string, groupId: number) {
    this.sql.run(
      "INSERT INTO background_retries VALUES (?,?)",
      operationId,
      groupId
    )
  }
}
