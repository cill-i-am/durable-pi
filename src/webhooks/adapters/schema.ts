import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

export const webhooks = sqliteTable(
  "webhooks",
  {
    routine_id: text("routine_id").notNull(),
    revision: integer("revision").notNull(),
    hash: text("hash"),
  },
  (t) => [
    primaryKey({ columns: [t.routine_id] }),
    check("webhooks_revision_check", sql`${t.revision} >= 0`),
  ]
)

export const webhookOperations = sqliteTable(
  "webhook_operations",
  {
    id: text("id").notNull(),
    input: text("input").notNull(),
    result: text("result").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })]
)

export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    routine_id: text("routine_id").notNull(),
    event_id: text("event_id").notNull(),
    hash: text("hash").notNull(),
    run_id: text("run_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.routine_id, t.event_id] })]
)
