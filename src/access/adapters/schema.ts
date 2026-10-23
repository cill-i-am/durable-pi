import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const accessConnections = sqliteTable(
  "access_connections",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    url: text("url").notNull(),
    revision: integer("revision").notNull(),
    active: integer("active").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("access_connections_active_check", sql`${t.active} in (0, 1)`),
    check("access_connections_revision_check", sql`${t.revision} >= 0`),
  ]
)

export const botRemoteTools = sqliteTable(
  "bot_remote_tools",
  {
    id: integer("id").notNull().primaryKey(),
    revision: integer("revision").notNull(),
    tools: text("tools").notNull(),
  },
  (t) => [
    check("bot_remote_tools_tools_json", sql`json_valid(${t.tools})`),
    check("bot_remote_tools_revision_check", sql`${t.revision} >= 0`),
    check("bot_remote_tools_id_singleton", sql`${t.id} = 1`),
  ]
)

export const toolGrants = sqliteTable(
  "tool_grants",
  {
    name: text("name").notNull(),
    mode: text("mode").notNull(),
    revision: integer("revision").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.name] }),
    check("tool_grants_mode_check", sql`${t.mode} in ('allow', 'ask', 'deny')`),
    check("tool_grants_revision_check", sql`${t.revision} >= 0`),
  ]
)

export const toolOperations = sqliteTable(
  "tool_operations",
  {
    id: text("id").notNull(),
    turnId: text("turnId").notNull(),
    tool: text("tool").notNull(),
    input: text("input").notNull(),
    createdAt: integer("createdAt").notNull(),
    expiresAt: integer("expiresAt").notNull(),
    status: text("status").notNull(),
    grantRevision: integer("grantRevision").notNull(),
    result: text("result"),
    revision: integer("revision").notNull().default(0),
    decision: text("decision"),
    schemaVersion: integer("schemaVersion").notNull().default(1),
    workflowVersion: integer("workflowVersion").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("tool_operations_run").on(t.turnId, t.createdAt, t.id),
    check(
      "tool_operations_status_check",
      sql`${t.status} in ('pending', 'approved', 'running', 'done', 'denied', 'cancelled', 'expired', 'interrupted')`
    ),
    check("tool_operations_revision_check", sql`${t.revision} >= 0`),
    check("tool_operations_grantRevision_check", sql`${t.grantRevision} >= 0`),
  ]
)

export const toolOperationHistory = sqliteTable(
  "tool_operation_history",
  {
    id: integer("id").notNull().primaryKey({ autoIncrement: true }),
    operationId: text("operationId").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").notNull(),
    at: integer("at").notNull(),
  },
  (t) => [
    index("tool_operation_history_operation").on(t.operationId, t.id),
    check(
      "tool_operation_history_status_check",
      sql`${t.status} in ('pending', 'approved', 'running', 'done', 'denied', 'cancelled', 'expired', 'interrupted')`
    ),
    check("tool_operation_history_revision_check", sql`${t.revision} >= 0`),
    foreignKey({
      columns: [t.operationId],
      foreignColumns: [toolOperations.id],
    }).onDelete("restrict"),
  ]
)
