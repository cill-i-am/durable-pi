import { Effect, Scheduler, Scope } from "effect"

import { makeDurableObjectSqlite } from "../../src/storage/durable-object"
import { migrateSqlite } from "../../src/storage/migrations"

/** Raw operations are fixture instrumentation only. Application modules receive
 * the coordinated first-party Effect Drizzle capability on this same database. */
export function nativeDatabase(
  storage: DurableObjectStorage,
  scope: Scope.Scope
) {
  const db = Effect.runSync(
    Effect.gen(function* () {
      const connection = yield* makeDurableObjectSqlite(storage)
      yield* migrateSqlite(connection)
      return connection
    }).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Scheduler.PreventSchedulerYield, true)
    )
  )
  return Object.assign(db, {
    all: <T>(query: string, ...bindings: (string | number | null)[]) =>
      storage.sql.exec(query, ...bindings).toArray() as T[],
    run: (query: string, ...bindings: (string | number | null)[]) => {
      storage.sql.exec(query, ...bindings)
    },
  })
}
