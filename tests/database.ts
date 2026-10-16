import { Effect, Exit, Scope } from "effect"
import { onTestFinished } from "vitest"

import { migrateSqlite } from "../src/storage/migrations"
import { makeNodeSqlite } from "../src/storage/node"
import type { Sqlite } from "../src/storage/sqlite"

export type TestSqlite = Sqlite & {
  all: <T>(query: string, ...bindings: (string | number | null)[]) => T[]
  run: (query: string, ...bindings: (string | number | null)[]) => void
}

/** Only test setup/seeding and assertions use the raw helpers. Stores use the
 * same first-party Drizzle Effect connection through the production interface. */
export function database(options: { migrate?: boolean } = {}): TestSqlite {
  const scope = Scope.makeUnsafe()
  onTestFinished(() => Effect.runPromise(Scope.close(scope, Exit.void)))
  const db = Effect.runSync(
    makeNodeSqlite().pipe(Effect.provideService(Scope.Scope, scope))
  )
  if (options.migrate !== false) Effect.runSync(migrateSqlite(db))
  return Object.assign(db, {
    all: <T>(query: string, ...bindings: (string | number | null)[]) =>
      Effect.runSync(
        db.use((orm) =>
          orm._.session
            .prepareQuery(
              { sql: query, params: bindings },
              "objects",
              false,
              "all"
            )
            .all()
        )
      ) as T[],
    run: (query: string, ...bindings: (string | number | null)[]) => {
      Effect.runSync(
        db.use((orm) =>
          orm._.session
            .prepareQuery(
              { sql: query, params: bindings },
              "objects",
              false,
              "run"
            )
            .run()
        )
      )
    },
  })
}

/** Deliberate disk-corruption fixtures bypass CHECK only for one mutation. */
export function corrupt(
  db: Pick<TestSqlite, "run">,
  query: string,
  ...bindings: (string | number | null)[]
) {
  db.run("PRAGMA ignore_check_constraints=ON")
  try {
    db.run(query, ...bindings)
  } finally {
    db.run("PRAGMA ignore_check_constraints=OFF")
  }
}
