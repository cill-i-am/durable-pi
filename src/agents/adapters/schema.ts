import { sql } from "drizzle-orm"
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

export const botConfiguration = sqliteTable(
  "bot_configuration",
  {
    id: integer("id").notNull().primaryKey(),
    owner: text("owner").notNull(),
    instructions: text("instructions").notNull(),
  },
  (t) => [check("bot_configuration_id_singleton", sql`${t.id} = 1`)]
)

export const botAdmission = sqliteTable(
  "bot_admission",
  {
    id: integer("id").notNull().primaryKey(),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
  },
  (t) => [
    check(
      "bot_admission_status_check",
      sql`${t.status} in ('active', 'archived')`
    ),
    check("bot_admission_revision_check", sql`${t.revision} >= 0`),
    check("bot_admission_id_singleton", sql`${t.id} = 1`),
  ]
)

export const agentCatalog = sqliteTable(
  "agent_catalog",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    slug: text("slug"),
    instructions: text("instructions").notNull(),
    status: text("status").notNull(),
    createdAt: text("createdAt").notNull(),
    updatedAt: text("updatedAt").notNull(),
    creation: text("creation").notNull(),
    revision: integer("revision").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("agent_catalog_slug").on(t.slug),
    check("agent_catalog_status", sql`${t.status} in ('active', 'archived')`),
    check("agent_catalog_revision_check", sql`${t.revision} >= 0`),
  ]
)
