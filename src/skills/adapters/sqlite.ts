import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import {
  SkillConflict,
  SkillDocument,
  SkillSelection,
  type SaveSkill,
  type Skill,
  type SelectSkills,
} from "../contracts"

/** The owner object owns the library; bot objects own explicitly pinned copies. */
export class SkillStore {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace_skills (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,archived INTEGER NOT NULL DEFAULT 0,stateRevision INTEGER NOT NULL DEFAULT 1)"
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(workspace_skills)")
        .some((column) => column.name === "stateRevision")
    )
      db.run(
        "ALTER TABLE workspace_skills ADD COLUMN stateRevision INTEGER NOT NULL DEFAULT 1"
      )
    db.run(
      "CREATE TABLE IF NOT EXISTS workspace_skill_versions (id TEXT NOT NULL,revision INTEGER NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,createdAt TEXT NOT NULL,PRIMARY KEY(id,revision))"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_skills (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,skills TEXT NOT NULL)"
    )
  }
  list(): Skill[] {
    return this.db
      .all<Omit<Skill, "archived"> & { archived: number }>(
        "SELECT v.*,s.archived,s.stateRevision FROM workspace_skills s JOIN workspace_skill_versions v ON s.id=v.id AND s.revision=v.revision ORDER BY v.name,s.id"
      )
      .map((value) => ({ ...value, archived: !!value.archived }))
  }
  versions(id: string) {
    return this.db.all<SkillDocument>(
      "SELECT * FROM workspace_skill_versions WHERE id=? ORDER BY revision DESC",
      id
    )
  }
  save(input: SaveSkill): Skill {
    return this.db.transaction(() => {
      const current = this.list().find((skill) => skill.id === input.id)
      if (current?.archived)
        throw new SkillConflict({
          message: "Restore this skill before editing it.",
        })
      if (
        current &&
        current.name === input.name &&
        current.body === input.body &&
        (input.expectedRevision === current.revision ||
          input.expectedRevision === current.revision - 1)
      )
        return current
      if ((current?.revision ?? 0) !== input.expectedRevision)
        throw new SkillConflict({
          message:
            "This skill changed in another window. Reload before saving.",
        })
      if (!current && this.list().length >= 100)
        throw new SkillConflict({
          message: "The library supports up to 100 skills.",
        })
      if ((current?.revision ?? 0) >= 100)
        throw new SkillConflict({
          message:
            "This skill has reached its 100-revision limit. Create a new skill to continue.",
        })
      const next = {
        id: input.id,
        name: input.name,
        body: input.body,
        revision: input.expectedRevision + 1,
        createdAt: new Date().toISOString(),
        archived: false,
        stateRevision: (current?.stateRevision ?? 0) + 1,
      }
      this.db.run(
        "INSERT INTO workspace_skill_versions VALUES (?,?,?,?,?)",
        next.id,
        next.revision,
        next.name,
        next.body,
        next.createdAt
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
      if (
        current &&
        current.stateRevision === expectedStateRevision + 1 &&
        current.archived === archived
      )
        return current
      if (!current || current.stateRevision !== expectedStateRevision)
        throw new SkillConflict({
          message: "This skill changed. Reload the library.",
        })
      if (current.archived === archived) return current
      this.db.run(
        "UPDATE workspace_skills SET archived=?,stateRevision=stateRevision+1 WHERE id=?",
        archived ? 1 : 0,
        id
      )
      return { ...current, archived, stateRevision: current.stateRevision + 1 }
    })
  }
  resolve(references: SelectSkills["skills"]): SkillDocument[] {
    if (new Set(references.map((value) => value.id)).size !== references.length)
      throw new SkillConflict({ message: "Select each skill once." })
    const library = this.list()
    return references.map((ref) => {
      if (!library.some((skill) => skill.id === ref.id && !skill.archived))
        throw new SkillConflict({
          message:
            "A selected skill is archived or unavailable. Reload the library.",
        })
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
      if (JSON.stringify(current.skills) === JSON.stringify(skills))
        return current
      if (current.revision !== expectedRevision)
        throw new SkillConflict({
          message: "This bot's skills changed. Reload before selecting again.",
        })
      this.db.run(
        "INSERT INTO bot_skills VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,skills=excluded.skills",
        current.revision + 1,
        JSON.stringify(skills)
      )
      return this.selection()
    })
  }
}
