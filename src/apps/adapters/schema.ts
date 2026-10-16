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

export const generatedApps = sqliteTable(
  "generated_apps",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    unique().on(t.id),
    check("generated_apps_record_json", sql`json_valid(${t.record})`),
  ]
)

export const generatedAppVersions = sqliteTable(
  "generated_app_versions",
  {
    id: text("id").notNull(),
    version: integer("version").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.version] }),
    check("generated_app_versions_record_json", sql`json_valid(${t.record})`),
    check("generated_app_versions_version_check", sql`${t.version} > 0`),
    foreignKey({
      columns: [t.id],
      foreignColumns: [generatedApps.id],
    }).onDelete("restrict"),
  ]
)

export const generatedAppOperations = sqliteTable(
  "generated_app_operations",
  {
    id: text("id").notNull(),
    input: text("input").notNull(),
    result: text("result").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("generated_app_operations_result_json", sql`json_valid(${t.result})`),
  ]
)

export const generatedAppEvents = sqliteTable(
  "generated_app_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    app_id: text("app_id").notNull(),
    record: text("record").notNull(),
    queued: integer("queued").notNull().default(0),
  },
  (t) => [
    unique().on(t.id),
    check("generated_app_events_record_json", sql`json_valid(${t.record})`),
    check("generated_app_events_queued_check", sql`${t.queued} in (0, 1)`),
    foreignKey({
      columns: [t.app_id],
      foreignColumns: [generatedApps.id],
    }).onDelete("restrict"),
    index("generated_app_events_app_sequence").on(t.app_id, t.sequence),
    index("generated_app_events_queued_sequence").on(t.queued, t.sequence),
  ]
)
