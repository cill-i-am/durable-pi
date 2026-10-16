import { primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const sqliteMigrations = sqliteTable(
  "__durable_pi_migrations",
  { id: text("id").notNull(), checksum: text("checksum").notNull() },
  (t) => [primaryKey({ columns: [t.id] })]
)
