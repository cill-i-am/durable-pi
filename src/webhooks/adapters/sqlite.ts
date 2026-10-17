import { and, count, eq } from "drizzle-orm"
import { Effect, Layer } from "effect"

import type { OperationReceipt } from "../../routines/persistence"
import {
  mapSqliteError,
  type Sqlite,
  type EffectSqliteDatabase,
} from "../../storage/sqlite"
import {
  WebhookPersistence,
  WebhookStorageError,
  type WebhookKeyRecord,
  type WebhookEventReceipt,
} from "../persistence"
import { webhooks, webhookOperations, webhookEvents } from "./schema"

type Records = WebhookPersistence["Service"]
export class SqliteWebhookPersistence implements Records {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private query<TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.use(body),
      (cause) => new WebhookStorageError({ operation: "query", cause })
    )
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new WebhookStorageError({ operation: "transaction", cause })
    )
  }
  key(id: string) {
    return this.query((orm) =>
      orm
        .select({ revision: webhooks.revision, hash: webhooks.hash })
        .from(webhooks)
        .where(eq(webhooks.routine_id, id))
    ).pipe(Effect.map((rows) => rows[0]))
  }
  putKey(id: string, key: WebhookKeyRecord) {
    return this.query((orm) =>
      orm
        .insert(webhooks)
        .values({ routine_id: id, ...key })
        .onConflictDoUpdate({ target: webhooks.routine_id, set: key })
    ).pipe(Effect.asVoid)
  }
  operation(id: string) {
    return this.query((orm) =>
      orm
        .select({
          input: webhookOperations.input,
          result: webhookOperations.result,
        })
        .from(webhookOperations)
        .where(eq(webhookOperations.id, id))
    ).pipe(Effect.map((rows) => rows[0]))
  }
  operationCount() {
    return this.query((orm) =>
      orm.select({ n: count() }).from(webhookOperations)
    ).pipe(Effect.map((rows) => rows[0]!.n))
  }
  putOperation(id: string, receipt: OperationReceipt) {
    return this.query((orm) =>
      orm.insert(webhookOperations).values({ id, ...receipt })
    ).pipe(Effect.asVoid)
  }
  event(id: string, eventId: string) {
    return this.query((orm) =>
      orm
        .select({ hash: webhookEvents.hash, run_id: webhookEvents.run_id })
        .from(webhookEvents)
        .where(
          and(
            eq(webhookEvents.routine_id, id),
            eq(webhookEvents.event_id, eventId)
          )
        )
    ).pipe(Effect.map((rows) => rows[0]))
  }
  eventCount(id?: string) {
    return this.query((orm) =>
      orm
        .select({ n: count() })
        .from(webhookEvents)
        .where(id === undefined ? undefined : eq(webhookEvents.routine_id, id))
    ).pipe(Effect.map((rows) => rows[0]!.n))
  }
  putEvent(id: string, eventId: string, receipt: WebhookEventReceipt) {
    return this.query((orm) =>
      orm
        .insert(webhookEvents)
        .values({ routine_id: id, event_id: eventId, ...receipt })
    ).pipe(Effect.asVoid)
  }
}
export const sqliteWebhookPersistence = (db: Sqlite) =>
  Layer.succeed(WebhookPersistence, new SqliteWebhookPersistence(db))
