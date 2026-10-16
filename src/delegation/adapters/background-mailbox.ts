import { Effect, Schema } from "effect"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { desc, eq, inArray } from "drizzle-orm"
import type { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import {
  backgroundHandoffs as handoffs,
  backgroundRetries as retries,
} from "./schema"
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

/** Drizzle persistence and codecs; decisions remain in BackgroundMailbox. */
export class SqliteBackgroundMailbox implements BackgroundLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  atomic<TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) {
    return mapSqliteError(
      this.db.transaction(body),
      (cause) => new BackgroundStorageError({ operation: "transaction", cause })
    )
  }
  private q<TValue>(work: Effect.Effect<TValue, EffectDrizzleQueryError>) {
    return mapSqliteError(
      work,
      (cause) => new BackgroundStorageError({ operation: "query", cause })
    )
  }
  get(id: number) {
    return this.db
      .use((orm) =>
        this.q(orm.select().from(handoffs).where(eq(handoffs.id, id)))
      )
      .pipe(
        Effect.map(([row]) => (row === undefined ? undefined : restore(row)))
      )
  }
  list(offset: number) {
    return this.db
      .use((orm) =>
        this.q(
          orm
            .select()
            .from(handoffs)
            .orderBy(desc(handoffs.id))
            .limit(20)
            .offset(offset)
        )
      )
      .pipe(Effect.map((rows) => rows.map(restore)))
  }
  unfinished() {
    return this.db
      .use((orm) =>
        this.q(
          orm
            .select()
            .from(handoffs)
            .where(
              inArray(handoffs.status, [
                "pending",
                "running",
                "ready",
                "paused",
              ])
            )
            .orderBy(handoffs.id)
        )
      )
      .pipe(Effect.map((rows) => rows.map(restore)))
  }
  hasTurn(turnId: string) {
    return this.db
      .use((orm) =>
        this.q(
          orm
            .select({ id: handoffs.id })
            .from(handoffs)
            .where(eq(handoffs.turn_id, turnId))
        )
      )
      .pipe(Effect.map((rows) => rows.length > 0))
  }
  put(row: Handoff) {
    return Effect.sync(() =>
      restore({ ...row, handoff: JSON.stringify(row.handoff) })
    ).pipe(
      Effect.andThen(() =>
        this.db.use((orm) =>
          this.q(
            orm
              .insert(handoffs)
              .values({ ...row, handoff: JSON.stringify(row.handoff) })
              .onConflictDoUpdate({
                target: handoffs.id,
                set: {
                  status: row.status,
                  report: row.report,
                  error: row.error,
                  failures: row.failures,
                  next_at: row.next_at,
                },
              })
          )
        )
      ),
      Effect.asVoid
    )
  }
  retry(operationId: string) {
    return this.db
      .use((orm) =>
        this.q(
          orm
            .select()
            .from(retries)
            .where(eq(retries.operation_id, operationId))
        )
      )
      .pipe(
        Effect.map(([row]) =>
          row === undefined
            ? undefined
            : Schema.decodeUnknownSync(BackgroundHandoff.fields.id)(
                row.group_id
              )
        )
      )
  }
  putRetry(operationId: string, groupId: number) {
    return this.db
      .use((orm) =>
        this.q(
          orm
            .insert(retries)
            .values({ operation_id: operationId, group_id: groupId })
        )
      )
      .pipe(Effect.asVoid)
  }
}
