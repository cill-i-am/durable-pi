import { sql } from "drizzle-orm"
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core"

export const workspaceFiles = sqliteTable(
  "workspace_files",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    kind: text("kind").notNull(),
    size: integer("size").notNull(),
    createdAt: text("createdAt").notNull(),
    status: text("status").notNull(),
    trashed: integer("trashed").notNull().default(0),
    hash: text("hash").notNull(),
    visionHash: text("visionHash"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check(
      "workspace_files_kind_check",
      sql`${t.kind} in ('image', 'text', 'video', 'document')`
    ),
    check(
      "workspace_files_status_check",
      sql`${t.status} in ('uploading', 'ready')`
    ),
    check("workspace_files_trashed_check", sql`${t.trashed} in (0, 1)`),
    check("workspace_files_size_check", sql`${t.size} >= 0`),
    index("workspace_files_created_id").on(t.createdAt, t.id),
  ]
)

export const workspaceExtractions = sqliteTable(
  "workspace_extractions",
  {
    id: text("id").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    pages: integer("pages").notNull().default(0),
    readPages: integer("readPages").notNull().default(0),
    characters: integer("characters").notNull().default(0),
    truncated: integer("truncated").notNull().default(0),
    error: text("error"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check(
      "workspace_extractions_status_check",
      sql`${t.status} in ('pending', 'running', 'ready', 'empty', 'failed')`
    ),
    check(
      "workspace_extractions_truncated_check",
      sql`${t.truncated} in (0, 1)`
    ),
    check("workspace_extractions_attempts_check", sql`${t.attempts} >= 0`),
    check("workspace_extractions_pages_check", sql`${t.pages} >= 0`),
    check("workspace_extractions_readPages_check", sql`${t.readPages} >= 0`),
    check("workspace_extractions_characters_check", sql`${t.characters} >= 0`),
    foreignKey({
      columns: [t.id],
      foreignColumns: [workspaceFiles.id],
    }).onDelete("cascade"),
  ]
)

export const workspaceVideoPreparations = sqliteTable(
  "workspace_video_preparations",
  {
    id: text("id").notNull(),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    duration: real("duration").notNull().default(0),
    frames: integer("frames").notNull().default(0),
    captions: integer("captions").notNull().default(0),
    error: text("error"),
    retry_at: integer("retry_at").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    check(
      "workspace_video_preparations_status_check",
      sql`${t.status} in ('pending', 'running', 'ready', 'failed')`
    ),
    check(
      "workspace_video_preparations_captions_check",
      sql`${t.captions} in (0, 1)`
    ),
    check(
      "workspace_video_preparations_attempts_check",
      sql`${t.attempts} >= 0`
    ),
    check(
      "workspace_video_preparations_duration_check",
      sql`${t.duration} >= 0`
    ),
    check("workspace_video_preparations_frames_check", sql`${t.frames} >= 0`),
    check(
      "workspace_video_preparations_retry_at_check",
      sql`${t.retry_at} >= 0`
    ),
    foreignKey({
      columns: [t.id],
      foreignColumns: [workspaceFiles.id],
    }).onDelete("cascade"),
  ]
)
