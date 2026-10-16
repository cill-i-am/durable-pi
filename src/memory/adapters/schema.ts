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

export const memoryBackupStatus = sqliteTable(
  "memory_backup_status",
  {
    id: integer("id").notNull().primaryKey(),
    date: text("date"),
    watermark: text("watermark").notNull(),
    error: text("error"),
  },
  (t) => [check("memory_backup_status_id_singleton", sql`${t.id} = 1`)]
)

export const summaryRoutes = sqliteTable(
  "summary_routes",
  {
    start: integer("start").notNull(),
    count: integer("count").notNull(),
    revision: integer("revision").notNull(),
    operation: text("operation").notNull(),
    route: text("route").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.start, t.count, t.revision] }),
    unique().on(t.operation),
    check("summary_routes_route_json", sql`json_valid(${t.route})`),
    check("summary_routes_requests_check", sql`${t.requests} >= 0`),
    check("summary_routes_count_check", sql`${t.count} > 0`),
    check("summary_routes_revision_check", sql`${t.revision} > 0`),
  ]
)

export const memoryLog = sqliteTable(
  "memory_log",
  {
    id: integer("id").notNull().primaryKey(),
    source: text("source").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    date: text("date").notNull(),
  },
  (t) => [
    unique().on(t.source),
    check(
      "memory_log_kind_check",
      sql`${t.kind} in ('user', 'talk', 'tool', 'echo', 'note')`
    ),
    check("memory_log_id_check", sql`${t.id} >= 0`),
  ]
)

export const memoryNodes = sqliteTable(
  "memory_nodes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    start: integer("start").notNull(),
    count: integer("count").notNull(),
    text: text("text").notNull(),
    bytes: integer("bytes").notNull(),
  },
  (t) => [
    unique().on(t.start, t.count),
    check("memory_nodes_start_check", sql`${t.start} >= 0`),
    check("memory_nodes_bytes_check", sql`${t.bytes} >= 0`),
    check("memory_nodes_count_check", sql`${t.count} > 0`),
  ]
)

export const memoryView = sqliteTable(
  "memory_view",
  {
    start: integer("start").notNull().primaryKey(),
    count: integer("count").notNull(),
  },
  (t) => [
    check("memory_view_start_check", sql`${t.start} >= 0`),
    check("memory_view_count_check", sql`${t.count} > 0`),
  ]
)

export const memoryFailures = sqliteTable(
  "memory_failures",
  {
    start: integer("start").notNull(),
    count: integer("count").notNull(),
    retry_at: integer("retry_at").notNull(),
    attempts: integer("attempts").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.start, t.count] }),
    check("memory_failures_start_check", sql`${t.start} >= 0`),
    check("memory_failures_count_check", sql`${t.count} > 0`),
    check("memory_failures_attempts_check", sql`${t.attempts} between 1 and 3`),
  ]
)

export const memoryNotes = sqliteTable(
  "memory_notes",
  {
    path: text("path").notNull(),
    body: text("body").notNull(),
    source_id: integer("source_id").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.path] }),
    foreignKey({
      columns: [t.source_id],
      foreignColumns: [memoryLog.id],
    }).onDelete("restrict"),
    index("memory_notes_source").on(t.source_id),
  ]
)

export const memoryNoteHistory = sqliteTable(
  "memory_note_history",
  {
    id: integer("id").notNull().primaryKey({ autoIncrement: true }),
    path: text("path").notNull(),
    body: text("body").notNull(),
    source_id: integer("source_id").notNull(),
    date: text("date").notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.source_id],
      foreignColumns: [memoryLog.id],
    }).onDelete("restrict"),
    index("memory_note_history_source").on(t.source_id),
  ]
)

export const memoryViewState = sqliteTable(
  "memory_view_state",
  {
    id: integer("id").notNull().primaryKey(),
    compacting: integer("compacting").notNull(),
  },
  (t) => [
    check("memory_view_state_compacting_check", sql`${t.compacting} in (0, 1)`),
    check("memory_view_state_id_singleton", sql`${t.id} in (1, 2)`),
  ]
)

export const memoryCompactionView = sqliteTable(
  "memory_compaction_view",
  {
    start: integer("start").notNull().primaryKey(),
    count: integer("count").notNull(),
  },
  (t) => [
    check("memory_compaction_view_start_check", sql`${t.start} >= 0`),
    check("memory_compaction_view_count_check", sql`${t.count} > 0`),
  ]
)

export const memoryReady = sqliteTable(
  "memory_ready",
  {
    start: integer("start").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.count, t.start] }),
    check("memory_ready_start_check", sql`${t.start} >= 0`),
    check("memory_ready_count_check", sql`${t.count} > 0`),
  ]
)

export const memoryMigrations = sqliteTable(
  "memory_migrations",
  {
    name: text("name").notNull(),
  },
  (t) => [primaryKey({ columns: [t.name] })]
)
