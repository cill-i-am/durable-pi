import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { AgentCatalog, type AgentDetails } from "../catalog"
import {
  AgentConflict,
  AgentNotFound,
  AgentProfile,
  AgentStorageError,
  homeAgentId,
  type AgentId,
} from "../domain"

export function sqliteAgentCatalog(db: Sqlite) {
  return Layer.sync(AgentCatalog, () => {
    db.run(`CREATE TABLE IF NOT EXISTS agent_catalog (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','archived')),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, creation TEXT NOT NULL)`)
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(agent_catalog)")
        .some((column) => column.name === "revision")
    )
      db.run(
        "ALTER TABLE agent_catalog ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
      )
    db.run(
      "INSERT OR IGNORE INTO agent_catalog (id,name,instructions,status,createdAt,updatedAt,creation) VALUES ('home','Personal assistant','','active',?,?,'legacy')",
      new Date().toISOString(),
      new Date().toISOString()
    )
    const decode = Schema.decodeUnknownSync(AgentProfile)
    const read = (id: AgentId) => {
      const row = db.all(
        "SELECT id,name,instructions,status,revision,createdAt,updatedAt FROM agent_catalog WHERE id=?",
        id
      )[0]
      if (!row) throw new AgentNotFound()
      return decode(row)
    }
    const attempt = <T>(body: () => T) =>
      Effect.try({
        try: body,
        catch: (cause) =>
          cause instanceof AgentNotFound || cause instanceof AgentConflict
            ? cause
            : new AgentStorageError(),
      })
    const capacity = () => {
      if (
        db.all<{ n: number }>(
          "SELECT count(*) AS n FROM agent_catalog WHERE status='active'"
        )[0]!.n >= 32
      )
        throw new AgentConflict({
          message:
            "Archive a bot before creating or restoring another. You can have 32 active bots.",
        })
    }
    return {
      list: () =>
        attempt(() =>
          db
            .all(
              "SELECT id,name,instructions,status,revision,createdAt,updatedAt FROM agent_catalog ORDER BY createdAt,id"
            )
            .map((row) => decode(row))
        ),
      requireActive: (id) =>
        attempt(() => {
          const agent = read(id)
          if (agent.status !== "active") throw new AgentNotFound()
          return agent
        }),
      create: (input: AgentDetails) =>
        attempt(() =>
          db.transaction(() => {
            const creation = JSON.stringify(input)
            const existing = db.all<{ creation: string }>(
              "SELECT creation FROM agent_catalog WHERE id=?",
              input.id
            )[0]
            if (existing) {
              if (existing.creation !== creation)
                throw new AgentConflict({
                  message: "This creation request belongs to another bot.",
                })
              return read(input.id)
            }
            capacity()
            const now = new Date().toISOString()
            db.run(
              "INSERT INTO agent_catalog (id,name,instructions,status,createdAt,updatedAt,creation) VALUES (?,?,?,'active',?,?,?)",
              input.id,
              input.name.trim(),
              input.instructions,
              now,
              now,
              creation
            )
            return read(input.id)
          })
        ),
      update: (input: AgentDetails) =>
        attempt(() =>
          db.transaction(() => {
            read(input.id)
            db.run(
              "UPDATE agent_catalog SET name=?,instructions=?,updatedAt=?,revision=revision+1 WHERE id=?",
              input.name.trim(),
              input.instructions,
              new Date().toISOString(),
              input.id
            )
            return read(input.id)
          })
        ),
      archive: (id, archived) =>
        attempt(() =>
          db.transaction(() => {
            const agent = read(id)
            if (id === homeAgentId && archived)
              throw new AgentConflict({
                message: "Your original personal assistant stays available.",
              })
            if (!archived && agent.status === "archived") capacity()
            db.run(
              "UPDATE agent_catalog SET status=?,updatedAt=?,revision=revision+1 WHERE id=?",
              archived ? "archived" : "active",
              new Date().toISOString(),
              id
            )
            return read(id)
          })
        ),
    }
  })
}
