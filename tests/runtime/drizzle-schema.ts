import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const drizzleProbeRows = sqliteTable("drizzle_probe_rows", {
  id: integer("id").primaryKey(),
  value: text("value").notNull(),
})
