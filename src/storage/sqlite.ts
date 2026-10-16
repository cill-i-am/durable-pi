import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite"
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core/errors"
import type { EffectSQLiteDoQueryEffectHKT } from "drizzle-orm/effect-sqlite-do/session"
import type { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect/db"
import { Cause, Effect, Schema } from "effect"
import { SqlError } from "effect/sql/SqlError"

/** Query builders are shared by the first-party DO and Node Effect drivers.
 * Transactions belong to Sqlite, never Drizzle's synchronous DO transaction. */
export type EffectSqliteDatabase = Omit<
  SQLiteEffectDatabase<EffectSQLiteDoQueryEffectHKT, unknown>,
  "transaction"
>
export type SqliteOrm = EffectSqliteDatabase
export type SqliteError = EffectDrizzleQueryError | SqlError

/** One database and operation coordinator per actor. All owned database work
 * enters use/transaction; the Pi adapter participates in that same coordinator. */
export interface Sqlite {
  use: <TValue, TError, TRequirements>(
    body: (
      orm: EffectSqliteDatabase
    ) => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError, TRequirements>
  transaction: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | SqlError, TRequirements>
  coordinatePi: (storage: SqliteStorage) => SqliteStorage
}

const isSqliteError = Schema.is(
  Schema.Union([EffectDrizzleQueryError, SqlError])
)

/** Translate every checked database failure without collapsing compound Causes.
 * Callback failures, defects, interruption and annotations retain their identity. */
export function mapSqliteError<TValue, TError, TRequirements, TFailure>(
  effect: Effect.Effect<TValue, TError, TRequirements>,
  failure: (cause: SqliteError) => TFailure
): Effect.Effect<
  TValue,
  Exclude<TError, SqliteError> | TFailure,
  TRequirements
> {
  return Effect.catchCause(effect, (cause) =>
    Effect.failCause(
      Cause.map(cause, (error) =>
        isSqliteError(error)
          ? failure(error)
          : (error as Exclude<TError, SqliteError>)
      )
    )
  )
}
