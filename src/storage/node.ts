import * as Driver from "@effect/sql-sqlite-node/SqliteClient"
import * as Drizzle from "drizzle-orm/effect-sqlite-node"
import { Context, Effect, Layer } from "effect"
import { makeSqlite } from "./effect"

/** Real SQLite adapter for tests and local tools. Its owned connection supports
 * asynchronous transaction composition and closes with the surrounding Scope. */
export function makeNodeSqlite(options: { filename?: string } = {}) {
  return Effect.gen(function* () {
    const services = yield* Layer.build(
      Driver.layer({ filename: options.filename ?? ":memory:" })
    )
    const client = Context.get(services, Driver.SqliteClient)
    const orm = yield* Drizzle.makeWithDefaults().pipe(
      Effect.provideContext(services)
    )
    return makeSqlite({}, orm, client.withTransaction)
  })
}
