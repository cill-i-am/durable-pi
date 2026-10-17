import { sql } from "drizzle-orm"
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

import type { WhatsAppDelivery, WhatsAppImage } from "../contracts"

export const whatsappSettings = sqliteTable(
  "whatsapp_settings",
  {
    id: integer("id").primaryKey(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    agentId: text("agent_id").notNull(),
    revision: integer("revision").notNull(),
    generation: integer("generation").notNull(),
    operationId: text("operation_id").notNull(),
    lastInboundAt: integer("last_inbound_at").notNull(),
  },
  (t) => [
    check("whatsapp_settings_singleton", sql`${t.id} = 1`),
    check("whatsapp_settings_enabled", sql`${t.enabled} in (0,1)`),
    check("whatsapp_settings_revision", sql`${t.revision} >= 0`),
    check("whatsapp_settings_generation", sql`${t.generation} >= 0`),
  ]
)

export const whatsappMessages = sqliteTable(
  "whatsapp_messages",
  {
    id: text("id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id").notNull(),
    sender: text("sender").notNull(),
    body: text("body").notNull(),
    timestamp: integer("timestamp").notNull(),
    image: text("image", { mode: "json" }).$type<WhatsAppImage>(),
    imageFileId: text("image_file_id"),
    outboundImageId: text("outbound_image_id"),
    imageAttempts: integer("image_attempts").notNull().default(0),
    agentId: text("agent_id").notNull(),
    generation: integer("generation").notNull(),
    control: integer("control", { mode: "boolean" }).notNull(),
    state: text("state").$type<WhatsAppDelivery>().notNull(),
    reply: text("reply").notNull().default(""),
    providerId: text("provider_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("whatsapp_messages_state_created").on(t.state, t.createdAt),
    check(
      "whatsapp_messages_state",
      sql`${t.state} in ('queued','waiting','sending','sent','failed','uncertain','cancelled','expired')`
    ),
    check("whatsapp_messages_control", sql`${t.control} in (0,1)`),
  ]
)

export const whatsappRetries = sqliteTable(
  "whatsapp_retries",
  {
    operationId: text("operation_id").notNull(),
    messageId: text("message_id")
      .notNull()
      .references(() => whatsappMessages.id),
    acknowledgeDuplicateRisk: integer("acknowledge_duplicate_risk", {
      mode: "boolean",
    }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.operationId] }),
    index("whatsapp_retries_message").on(t.messageId),
    check(
      "whatsapp_retries_acknowledgement",
      sql`${t.acknowledgeDuplicateRisk} in (0,1)`
    ),
  ]
)
