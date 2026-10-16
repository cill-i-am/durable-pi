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
import { sql } from "drizzle-orm"

export const chatActivity = sqliteTable(
  "chat_activity",
  {
    turn_id: text("turn_id").notNull(),
    payload: text("payload").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.turn_id] }),
    check("chat_activity_payload_json", sql`json_valid(${t.payload})`),
    foreignKey({
      columns: [t.turn_id],
      foreignColumns: [chatTurns.id],
    }).onDelete("restrict"),
  ]
)

export const chatRecoveryHistory = sqliteTable(
  "chat_recovery_history",
  {
    id: integer("id").notNull().primaryKey({ autoIncrement: true }),
    turn_id: text("turn_id").notNull(),
    at: text("at").notNull(),
    view: text("view").notNull(),
  },
  (t) => [
    index("chat_recovery_run").on(t.turn_id, t.id),
    check("chat_recovery_history_view_json", sql`json_valid(${t.view})`),
    foreignKey({
      columns: [t.turn_id],
      foreignColumns: [chatTurns.id],
    }).onDelete("restrict"),
  ]
)

export const chatTurns = sqliteTable(
  "chat_turns",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    text: text("text").notNull(),
    status: text("status").notNull(),
    answer: text("answer").notNull().default(""),
    error: text("error"),
    created_at: text("created_at").notNull(),
    session_id: text("session_id"),
    prompt: text("prompt"),
    parent_id: text("parent_id"),
    started_at: text("started_at"),
    finished_at: text("finished_at"),
    stopped_at: text("stopped_at"),
    recovery: text("recovery"),
    mode: text("mode").notNull().default("followUp"),
    delivery: text("delivery").notNull().default("queued"),
    model: text("model"),
    routing: text("routing"),
    origin: text("origin"),
    thinking: text("thinking"),
    revision: integer("revision").notNull().default(0),
    creation: text("creation"),
    attachments: text("attachments").notNull().default("[]"),
    input: text("input").notNull().default("[]"),
    skills: text("skills").notNull().default("[]"),
    skill_context: text("skill_context").notNull().default(""),
  },
  (t) => [
    unique().on(t.id),
    check(
      "chat_turns_status_check",
      sql`${t.status} in ('queued', 'preparing', 'running', 'stopping', 'done', 'failed', 'cancelled')`
    ),
    check("chat_turns_mode_check", sql`${t.mode} in ('followUp', 'steer')`),
    check(
      "chat_turns_delivery_check",
      sql`${t.delivery} in ('queued', 'accepted', 'consumed', 'answered', 'unanswered')`
    ),
    check("chat_turns_attachments_json", sql`json_valid(${t.attachments})`),
    check("chat_turns_skills_json", sql`json_valid(${t.skills})`),
    check("chat_turns_input_json", sql`json_valid(${t.input})`),
    check(
      "chat_turns_routing_json",
      sql`${t.routing} is null or json_valid(${t.routing})`
    ),
    check(
      "chat_turns_origin_json",
      sql`${t.origin} is null or json_valid(${t.origin})`
    ),
    check(
      "chat_turns_recovery_json",
      sql`${t.recovery} is null or json_valid(${t.recovery})`
    ),
    check("chat_turns_revision_check", sql`${t.revision} >= 0`),
    foreignKey({ columns: [t.parent_id], foreignColumns: [t.id] }).onDelete(
      "restrict"
    ),
    index("chat_turns_status_sequence").on(t.status, t.sequence),
    index("chat_turns_parent_sequence").on(t.parent_id, t.sequence),
  ]
)

export const jobModelSettings = sqliteTable(
  "job_model_settings",
  {
    job: text("job").notNull(),
    model: text("model").notNull(),
    thinking: text("thinking").notNull(),
  },
  (t) => [primaryKey({ columns: [t.job] })]
)

export const chatSettings = sqliteTable(
  "chat_settings",
  {
    id: integer("id").notNull().primaryKey(),
    model: text("model").notNull(),
    thinking: text("thinking").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [
    check("chat_settings_revision_check", sql`${t.revision} >= 0`),
    check("chat_settings_id_singleton", sql`${t.id} = 1`),
  ]
)
