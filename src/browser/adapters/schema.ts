import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const botBrowser = sqliteTable(
  "bot_browser",
  {
    id: integer("id").notNull().primaryKey(),
    record: text("record").notNull(),
  },
  (t) => [
    check("bot_browser_record_json", sql`json_valid(${t.record})`),
    check("bot_browser_id_singleton", sql`${t.id} = 1`),
  ]
)

export const retiredBrowsers = sqliteTable(
  "retired_browsers",
  {
    id: text("id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })]
)
