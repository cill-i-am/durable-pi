import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core"

export const backgroundHandoffs = sqliteTable(
  "background_handoffs",
  {
    id: integer("id").notNull().primaryKey(),
    turn_id: text("turn_id").notNull(),
    handoff: text("handoff").notNull(),
    status: text("status").notNull(),
    report: text("report"),
    error: text("error"),
    failures: integer("failures").notNull().default(0),
    next_at: integer("next_at"),
  },
  (t) => [
    unique().on(t.turn_id),
    check(
      "background_handoffs_status_check",
      sql`${t.status} in ('pending', 'running', 'ready', 'delivered', 'cancelled', 'paused')`
    ),
    check("background_handoffs_handoff_json", sql`json_valid(${t.handoff})`),
    check("background_handoffs_failures_check", sql`${t.failures} >= 0`),
  ]
)

export const backgroundRetries = sqliteTable(
  "background_retries",
  {
    operation_id: text("operation_id").notNull(),
    group_id: integer("group_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.operation_id] }),
    foreignKey({
      columns: [t.group_id],
      foreignColumns: [backgroundHandoffs.id],
    }).onDelete("restrict"),
    index("background_retries_group").on(t.group_id),
  ]
)
