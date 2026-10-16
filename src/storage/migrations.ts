import { inArray, sql } from "drizzle-orm"
import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Effect, Scheduler, Schema } from "effect"

import { agentMigrationManifest as manifest } from "./migration-manifest"
import { sqliteMigrations } from "./migration-schema"
import type { Sqlite } from "./sqlite"

export class SqliteMigrationError extends Schema.TaggedError<SqliteMigrationError>()(
  "SqliteMigrationError",
  { message: Schema.String }
) {}
const sqliteSchema = sqliteTable("sqlite_schema", {
  type: text("type").notNull(),
  name: text("name").notNull(),
  sql: text("sql"),
})
const reject = (message: string) => new SqliteMigrationError({ message })

/** Apply generated migrations atomically. Unversioned application storage needs
 * an explicit actor reset; SDK-owned tables are never dropped by this module. */
export function migrateSqlite(db: Sqlite, options: { audit?: boolean } = {}) {
  return db
    .transaction(() =>
      Effect.gen(function* () {
        const schema = yield* db.use((orm) =>
          orm
            .select()
            .from(sqliteSchema)
            .where(
              inArray(
                sqliteSchema.name,
                manifest.schema.map((item) => item.name)
              )
            )
        )
        const hasHistory = schema.some(
          (item) =>
            item.name === "__durable_pi_migrations" && item.type === "table"
        )
        if (!hasHistory && schema.length)
          return yield* reject(
            "Existing application storage uses an unversioned schema. Reset the actor's complete durable storage before initializing this schema."
          )
        const applied = hasHistory
          ? yield* db.use((orm) => orm.select().from(sqliteMigrations))
          : []
        const versions = new Map(
          manifest.versions.map((version) => [version.id as string, version])
        )
        for (const saved of applied) {
          if (versions.get(saved.id)?.checksum !== saved.checksum)
            return yield* reject(
              `SQLite migration history mismatch: ${saved.id}`
            )
        }
        const completed = new Set(applied.map((item) => item.id))
        let missing = false
        for (const version of manifest.versions) {
          if (completed.has(version.id)) {
            if (missing)
              return yield* reject(
                `SQLite migration history has a gap: ${version.id}`
              )
            continue
          }
          missing = true
          for (const generated of version.statements)
            yield* db.use((orm) => orm.run(sql.raw(generated)))
          yield* db.use((orm) =>
            orm
              .insert(sqliteMigrations)
              .values({ id: version.id, checksum: version.checksum })
          )
        }
        if (options.audit) {
          const actual = missing
            ? yield* db.use((orm) =>
                orm
                  .select()
                  .from(sqliteSchema)
                  .where(
                    inArray(
                      sqliteSchema.name,
                      manifest.schema.map((item) => item.name)
                    )
                  )
              )
            : schema
          for (const expected of manifest.schema) {
            const saved = actual.find((item) => item.name === expected.name)
            if (
              !saved ||
              saved.type !== expected.type ||
              saved.sql !== expected.sql
            )
              return yield* reject(`SQLite schema drift: ${expected.name}`)
          }
        }
      })
    )
    .pipe(Effect.provideService(Scheduler.PreventSchedulerYield, true))
}
