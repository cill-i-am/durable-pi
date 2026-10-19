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

export const agentMessages = sqliteTable(
  "agent_messages",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    operation_id: text("operation_id").notNull(),
    sender_session: text("sender_session").notNull(),
    sender_agent: text("sender_agent").notNull(),
    recipient_session: text("recipient_session").notNull(),
    recipient_agent: text("recipient_agent").notNull(),
    payload: text("payload").notNull(),
    state: text("state", {
      enum: ["accepted", "delivered", "failed"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    retry_at: integer("retry_at").notNull(),
    error: text("error"),
  },
  (t) => [
    unique().on(t.id),
    unique().on(t.operation_id),
    index("agent_messages_pending").on(t.state, t.retry_at),
    index("agent_messages_recipient").on(
      t.recipient_session,
      t.recipient_agent,
      t.sequence
    ),
    index("agent_messages_sender").on(t.sender_session, t.sender_agent),
    check("agent_messages_payload_json", sql`json_valid(${t.payload})`),
    check(
      "agent_messages_state_check",
      sql`${t.state} in ('accepted','delivered','failed')`
    ),
    check("agent_messages_attempts_check", sql`${t.attempts} >= 0`),
  ]
)
export const agentSessionLimits = sqliteTable(
  "agent_session_limits",
  {
    id: text("id").notNull(),
    closed: integer("closed", { mode: "boolean" }).notNull().default(false),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("agent_session_requests_check", sql`${t.requests} >= 0`),
    check("agent_session_closed_check", sql`${t.closed} in (0, 1)`),
  ]
)
