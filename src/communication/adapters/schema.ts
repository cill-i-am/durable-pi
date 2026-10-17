import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core"

export const communicationIdentity = sqliteTable(
  "communication_identity",
  {
    id: text("id").notNull(),
    body: text("body").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("communication_identity_body_json", sql`json_valid(${t.body})`),
  ]
)

export const communicationOutbox = sqliteTable(
  "communication_outbox",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    next_at: integer("next_at"),
  },
  (t) => [
    unique().on(t.id),
    index("communication_outbox_due").on(t.status, t.next_at),
    check(
      "communication_outbox_status_check",
      sql`${t.status} in ('pending', 'delivering', 'accepted', 'failed', 'expired')`
    ),
    check("communication_outbox_body_json", sql`json_valid(${t.body})`),
  ]
)

export const communicationInbox = sqliteTable(
  "communication_inbox",
  {
    id: text("id").notNull(),
    content: text("content").notNull(),
    receipt: text("receipt").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("communication_inbox_content_json", sql`json_valid(${t.content})`),
    check("communication_inbox_receipt_json", sql`json_valid(${t.receipt})`),
  ]
)

export const communicationTasks = sqliteTable(
  "communication_tasks",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    body: text("body").notNull(),
    status: text("status").notNull(),
    lease_until: integer("lease_until"),
    deadline: integer("deadline").notNull(),
    direction: text("direction").notNull(),
  },
  (t) => [
    unique().on(t.id),
    check(
      "communication_tasks_status_check",
      sql`${t.status} in ('accepted', 'running', 'waiting', 'completed', 'failed', 'expired', 'cancelling', 'cancelled', 'awaiting_input')`
    ),
    check(
      "communication_tasks_direction_check",
      sql`${t.direction} in ('incoming', 'outgoing')`
    ),
    check("communication_tasks_body_json", sql`json_valid(${t.body})`),
    index("communication_tasks_direction_status_sequence").on(
      t.direction,
      t.status,
      t.sequence
    ),
  ]
)

export const communicationCancellations = sqliteTable(
  "communication_cancellations",
  {
    id: text("id").notNull(),
    body: text("body").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("communication_cancellations_body_json", sql`json_valid(${t.body})`),
  ]
)
