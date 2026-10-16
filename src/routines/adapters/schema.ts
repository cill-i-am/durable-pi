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

export const routines = sqliteTable(
  "routines",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    unique().on(t.id),
    check("routines_record_json", sql`json_valid(${t.record})`),
  ]
)

export const routineRuns = sqliteTable(
  "routine_runs",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    routine_id: text("routine_id").notNull(),
    turn_id: text("turn_id").notNull(),
    status: text("status").notNull(),
    record: text("record").notNull(),
  },
  (t) => [
    unique().on(t.id),
    unique().on(t.turn_id),
    check(
      "routine_runs_status_check",
      sql`${t.status} in ('pending', 'queued', 'done', 'failed', 'cancelled')`
    ),
    check("routine_runs_record_json", sql`json_valid(${t.record})`),
    foreignKey({
      columns: [t.routine_id],
      foreignColumns: [routines.id],
    }).onDelete("restrict"),
    index("routine_runs_routine_sequence").on(t.routine_id, t.sequence),
    index("routine_runs_status_sequence").on(t.status, t.sequence),
  ]
)

export const routineOperations = sqliteTable(
  "routine_operations",
  {
    id: text("id").notNull(),
    input: text("input").notNull(),
    result: text("result").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("routine_operations_result_json", sql`json_valid(${t.result})`),
  ]
)
