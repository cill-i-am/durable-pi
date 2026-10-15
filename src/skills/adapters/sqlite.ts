import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import {
  SkillConflict,
  SkillStorageError,
  SkillDocument,
  SkillSelection,
  type SaveSkill,
  type Skill,
  type SelectSkills,
} from "../contracts"
import { SkillSource } from "../source"
import * as Domain from "../domain"
import type { SkillLedger } from "../repository"

function document(
  row: Omit<SkillDocument, "source"> & { source?: string | null }
): SkillDocument {
  const { source, ...value } = row
  return Schema.decodeUnknownSync(SkillDocument)({
    ...value,
    ...(source
      ? { source: Schema.decodeUnknownSync(SkillSource)(JSON.parse(source)) }
      : {}),
  })
}

export class SkillStore implements SkillLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch (cause) {
        throw new SkillStorageError({ operation, cause })
      }
    }
    this.db = {
      all: (query, ...bindings) =>
        storage("read", () => db.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => db.run(query, ...bindings)),
      transaction: (body) => {
        const failure: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return db.transaction(() => {
            try {
              return body()
            } catch (cause) {
              failure.failed = true
              failure.cause = cause
              throw cause
            }
          })
        } catch (cause) {
          if (failure.failed && cause === failure.cause) throw cause
          throw new SkillStorageError({ operation: "transaction", cause })
        }
      },
    }

    this.db.run(
      "CREATE TABLE IF NOT EXISTS workspace_skills (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,stateRevision INTEGER NOT NULL DEFAULT 1)"
    )
    if (
      !this.db
        .all<{ name: string }>("PRAGMA table_info(workspace_skills)")
        .some((column) => column.name === "stateRevision")
    )
      this.db.run(
        "ALTER TABLE workspace_skills ADD COLUMN stateRevision INTEGER NOT NULL DEFAULT 1"
      )
    this.db.run(
      "CREATE TABLE IF NOT EXISTS workspace_skill_versions (id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(id,revision))"
    )
    if (
      !this.db
        .all<{ name: string }>("PRAGMA table_info(workspace_skill_versions)")
        .some((column) => column.name === "source")
    )
      this.db.run("ALTER TABLE workspace_skill_versions ADD COLUMN source TEXT")
    this.db.run(
      "CREATE TABLE IF NOT EXISTS bot_skills (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,skills TEXT NOT NULL)"
    )
  }
  list(): Skill[] {
    return this.db
      .all<
        Omit<Skill, "archived" | "source"> & {
          archived: number
          source: string | null
        }
      >(
        "SELECT v.*,s.archived,s.stateRevision FROM workspace_skills s JOIN workspace_skill_versions v ON s.id=v.id AND s.revision=v.revision ORDER BY v.name,s.id"
      )
      .map((value) => ({
        ...document(value),
        archived: !!value.archived,
        stateRevision: value.stateRevision,
      }))
  }
  versions(id: string) {
    return this.db
      .all<Omit<SkillDocument, "source"> & { source: string | null }>(
        "SELECT * FROM workspace_skill_versions WHERE id=? ORDER BY revision DESC",
        id
      )
      .map(document)
  }
  save(input: SaveSkill): Skill {
    return this.db.transaction(() => {
      const current = this.list().find((skill) => skill.id === input.id)
      const next = Domain.saveSkill(
        input,
        current,
        current ? 0 : this.list().length,
        new Date().toISOString()
      )
      if (next === current) return current
      this.db.run(
        "INSERT INTO workspace_skill_versions (id,revision,name,body,createdAt,source) VALUES (?,?,?,?,?,?)",
        next.id,
        next.revision,
        next.name,
        next.body,
        next.createdAt,
        next.source ? JSON.stringify(next.source) : null
      )
      this.db.run(
        "INSERT INTO workspace_skills(id,revision,archived,stateRevision) VALUES (?,?,0,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,stateRevision=excluded.stateRevision",
        next.id,
        next.revision,
        next.stateRevision
      )
      return next
    })
  }
  archive(id: string, expectedStateRevision: number, archived: boolean) {
    return this.db.transaction(() => {
      const current = this.list().find((skill) => skill.id === id)
      const next = Domain.archiveSkill(current, expectedStateRevision, archived)
      if (next === current) return current
      this.db.run(
        "UPDATE workspace_skills SET archived=?,stateRevision=stateRevision+1 WHERE id=?",
        archived ? 1 : 0,
        id
      )
      return next
    })
  }
  resolve(references: SelectSkills["skills"]): SkillDocument[] {
    Domain.uniqueReferences(references)
    const library = this.list()
    return references.map((ref) => {
      Domain.requireAvailableSkill(library, ref.id)
      const value = this.versions(ref.id).find(
        (version) => version.revision === ref.revision
      )
      if (!value)
        throw new SkillConflict({
          message: "This skill revision is unavailable.",
        })
      return Schema.decodeUnknownSync(SkillDocument)(value)
    })
  }
  selection(): SkillSelection {
    const row = this.db.all<{ revision: number; skills: string }>(
      "SELECT revision,skills FROM bot_skills WHERE id=1"
    )[0]
    return row
      ? Schema.decodeUnknownSync(SkillSelection)({
          revision: row.revision,
          skills: JSON.parse(row.skills),
        })
      : { revision: 0, skills: [] }
  }
  select(expectedRevision: number, skills: readonly SkillDocument[]) {
    return this.db.transaction(() => {
      const current = this.selection()
      const next = Domain.selectSkills(current, expectedRevision, skills)
      if (next === current) return current
      this.db.run(
        "INSERT INTO bot_skills VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,skills=excluded.skills",
        next.revision,
        JSON.stringify(next.skills)
      )
      return this.selection()
    })
  }
}
