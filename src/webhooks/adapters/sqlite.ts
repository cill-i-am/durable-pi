import { Layer } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import type { OperationReceipt } from "../../routines/persistence"
import {
  WebhookPersistence,
  WebhookStorageError,
  type WebhookKeyRecord,
  type WebhookEventReceipt,
} from "../persistence"

type Records = WebhookPersistence["Service"]
export class SqliteWebhookPersistence implements Records {
  readonly transactionGroup: object
  private readonly db: Sqlite
  constructor(db: Sqlite) {
    this.transactionGroup = db
    const storage = <TResult>(
      operation: string,
      body: () => TResult
    ): TResult => {
      try {
        return body()
      } catch (cause) {
        throw new WebhookStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const failure: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              failure.failed = true
              failure.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (failure.failed && cause === failure.cause) throw cause
          throw new WebhookStorageError({ operation: "transaction", cause })
        }
      },
    }
    this.db.run(
      "CREATE TABLE IF NOT EXISTS webhooks (routine_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, hash TEXT)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS webhook_operations (id TEXT PRIMARY KEY, input TEXT NOT NULL, result TEXT NOT NULL)"
    )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS webhook_events (routine_id TEXT NOT NULL,event_id TEXT NOT NULL,hash TEXT NOT NULL,run_id TEXT NOT NULL, PRIMARY KEY(routine_id,event_id))"
    )
  }
  atomic<TResult>(body: () => TResult) {
    return this.db.transaction(body)
  }
  key(id: string) {
    return this.db.all<WebhookKeyRecord>(
      "SELECT revision,hash FROM webhooks WHERE routine_id=?",
      id
    )[0]
  }
  putKey(id: string, key: WebhookKeyRecord) {
    this.db.run(
      "INSERT INTO webhooks VALUES (?,?,?) ON CONFLICT(routine_id) DO UPDATE SET revision=excluded.revision,hash=excluded.hash",
      id,
      key.revision,
      key.hash
    )
  }
  operation(id: string) {
    return this.db.all<OperationReceipt>(
      "SELECT input,result FROM webhook_operations WHERE id=?",
      id
    )[0]
  }
  operationCount() {
    return this.db.all<{ n: number }>(
      "SELECT count(*) AS n FROM webhook_operations"
    )[0]!.n
  }
  putOperation(id: string, receipt: OperationReceipt) {
    this.db.run(
      "INSERT INTO webhook_operations VALUES (?,?,?)",
      id,
      receipt.input,
      receipt.result
    )
  }
  event(id: string, eventId: string) {
    return this.db.all<WebhookEventReceipt>(
      "SELECT hash,run_id FROM webhook_events WHERE routine_id=? AND event_id=?",
      id,
      eventId
    )[0]
  }
  eventCount(id?: string) {
    return id === undefined
      ? this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM webhook_events"
        )[0]!.n
      : this.db.all<{ n: number }>(
          "SELECT count(*) AS n FROM webhook_events WHERE routine_id=?",
          id
        )[0]!.n
  }
  putEvent(id: string, eventId: string, receipt: WebhookEventReceipt) {
    this.db.run(
      "INSERT INTO webhook_events VALUES (?,?,?,?)",
      id,
      eventId,
      receipt.hash,
      receipt.run_id
    )
  }
}
export const sqliteWebhookPersistence = (db: Sqlite) =>
  Layer.sync(WebhookPersistence, () => new SqliteWebhookPersistence(db))
