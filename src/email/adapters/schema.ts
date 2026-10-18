import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

import type { ReplyProgress } from "../../replies/contracts"
import type { EmailDelivery } from "../contracts"

export const emailSettings = sqliteTable(
  "email_settings",
  {
    id: integer("id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    revision: integer("revision").notNull(),
    generation: integer("generation").notNull(),
    operationId: text("operation_id").notNull(),
  },
  (t) => [
    check("email_settings_singleton", sql`${t.id} = 1`),
    check("email_settings_enabled", sql`${t.enabled} in (0,1)`),
    check("email_settings_revision", sql`${t.revision} >= 0`),
    check("email_settings_generation", sql`${t.generation} >= 0`),
  ]
)
export const emailMessages = sqliteTable(
  "email_messages",
  {
    id: text("id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    messageId: text("message_id").notNull(),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    references: text("references").notNull(),
    files: text("files", { mode: "json" })
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    purpose: text("purpose").notNull().default("request"),
    noticeKey: text("notice_key"),
    state: text("state").$type<EmailDelivery>().notNull(),
    reply: text("reply").notNull().default(""),
    delivery: text("delivery", { mode: "json" }).$type<ReplyProgress>(),
    providerId: text("provider_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("email_messages_state_created").on(t.state, t.createdAt),
    uniqueIndex("email_messages_notice").on(t.noticeKey),
    check(
      "email_messages_state",
      sql`${t.state} in ('queued','waiting','sending','sent','failed','uncertain','cancelled')`
    ),
  ]
)
export const emailRetries = sqliteTable(
  "email_retries",
  {
    operationId: text("operation_id").notNull(),
    emailId: text("email_id")
      .notNull()
      .references(() => emailMessages.id),
    acknowledgeDuplicateRisk: integer("acknowledge_duplicate_risk", {
      mode: "boolean",
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.operationId] }),
    index("email_retries_email").on(t.emailId),
    check(
      "email_retries_acknowledgement",
      sql`${t.acknowledgeDuplicateRisk} in (0,1)`
    ),
  ]
)
