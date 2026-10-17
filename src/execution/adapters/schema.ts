import { sql } from "drizzle-orm"
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const codeRuns = sqliteTable(
  "code_runs",
  {
    id: text("id").notNull(),
    created: integer("created").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("code_runs_record_json", sql`json_valid(${t.record})`),
  ]
)
