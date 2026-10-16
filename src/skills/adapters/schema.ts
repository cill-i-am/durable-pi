import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const workspaceSkills = sqliteTable(
  "workspace_skills",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    archived: integer("archived").notNull().default(0),
    stateRevision: integer("stateRevision").notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check("workspace_skills_archived_check", sql`${t.archived} in (0, 1)`),
    check("workspace_skills_revision_check", sql`${t.revision} > 0`),
    check("workspace_skills_stateRevision_check", sql`${t.stateRevision} > 0`),
  ]
)

export const workspaceSkillVersions = sqliteTable(
  "workspace_skill_versions",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    name: text("name").notNull(),
    body: text("body").notNull(),
    createdAt: text("createdAt").notNull(),
    source: text("source"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.revision] }),
    check(
      "workspace_skill_versions_source_json",
      sql`${t.source} is null or json_valid(${t.source})`
    ),
    check("workspace_skill_versions_revision_check", sql`${t.revision} > 0`),
    foreignKey({
      columns: [t.id],
      foreignColumns: [workspaceSkills.id],
    }).onDelete("restrict"),
  ]
)

export const botSkills = sqliteTable(
  "bot_skills",
  {
    id: integer("id").notNull().primaryKey(),
    revision: integer("revision").notNull(),
    skills: text("skills").notNull(),
  },
  (t) => [
    check("bot_skills_skills_json", sql`json_valid(${t.skills})`),
    check("bot_skills_revision_check", sql`${t.revision} >= 0`),
    check("bot_skills_id_singleton", sql`${t.id} = 1`),
  ]
)
