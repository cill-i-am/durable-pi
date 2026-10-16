import { sql } from "drizzle-orm"
import {
  check,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const terminalNetwork = sqliteTable(
  "terminal_network",
  {
    id: integer("id").notNull().primaryKey(),
    revision: integer("revision").notNull(),
    unrestricted: integer("unrestricted").notNull(),
  },
  (t) => [
    check("terminal_network_singleton", sql`${t.id} = 1`),
    check(
      "terminal_network_unrestricted_check",
      sql`${t.unrestricted} in (0, 1)`
    ),
    check("terminal_network_revision_check", sql`${t.revision} >= 0`),
  ]
)

export const terminalRuns = sqliteTable(
  "terminal_runs",
  {
    id: text("id").notNull(),
    created: integer("created").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("terminal_runs_record_json", sql`json_valid(${t.record})`),
  ]
)

export const terminalCheckpoint = sqliteTable(
  "terminal_checkpoint",
  {
    id: integer("id").notNull().primaryKey(),
    record: text("record").notNull(),
  },
  (t) => [
    check("terminal_checkpoint_singleton", sql`${t.id} = 1`),
    check("terminal_checkpoint_record_json", sql`json_valid(${t.record})`),
  ]
)

export const terminalCancellations = sqliteTable(
  "terminal_cancellations",
  {
    id: text("id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })]
)

export const terminalAuthority = sqliteTable(
  "terminal_authority",
  {
    id: integer("id").notNull().primaryKey(),
    revision: integer("revision").notNull(),
    active: integer("active").notNull(),
    revoked_through: integer("revoked_through").notNull().default(-1),
  },
  (t) => [
    check("terminal_authority_singleton", sql`${t.id} = 1`),
    check("terminal_authority_active_check", sql`${t.active} in (0, 1)`),
    check("terminal_authority_revision_check", sql`${t.revision} >= 0`),
  ]
)

export const terminalExports = sqliteTable(
  "terminal_exports",
  {
    id: text("id").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("terminal_exports_record_json", sql`json_valid(${t.record})`),
  ]
)
