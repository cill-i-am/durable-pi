import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import type { AgentCatalogLedger } from "../ledger"
import { agentCatalogApplication } from "../service"
import { AgentProfile, AgentStorageError, type AgentId } from "../domain"

const Count = Schema.Struct({
  n: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
const Creation = Schema.Struct({ creation: Schema.String })
export class SqliteAgentCatalog implements AgentCatalogLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
    this.native(() =>
      db.run(`CREATE TABLE IF NOT EXISTS agent_catalog (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, instructions TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','archived')),
      createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, creation TEXT NOT NULL)`)
    )
    if (
      !this.native(() =>
        db.all<{ name: string }>("PRAGMA table_info(agent_catalog)")
      ).some((column) => column.name === "revision")
    )
      this.native(() =>
        db.run(
          "ALTER TABLE agent_catalog ADD COLUMN revision INTEGER NOT NULL DEFAULT 0"
        )
      )
  }
  private native<T>(body: () => T): T {
    try {
      return body()
    } catch {
      throw new AgentStorageError()
    }
  }
  atomic<T>(body: () => T): T {
    const callback: { failed: boolean; cause?: unknown } = { failed: false }
    try {
      return this.db.transaction(() => {
        try {
          return body()
        } catch (cause) {
          callback.failed = true
          callback.cause = cause
          throw cause
        }
      })
    } catch (cause) {
      if (callback.failed && cause === callback.cause) throw cause
      throw new AgentStorageError()
    }
  }
  list() {
    return this.native(() =>
      this.db.all<unknown>(
        "SELECT id,name,instructions,status,revision,createdAt,updatedAt FROM agent_catalog ORDER BY createdAt,id"
      )
    ).map((row) => Schema.decodeUnknownSync(AgentProfile)(row))
  }
  read(id: AgentId) {
    const row = this.native(() =>
      this.db.all<unknown>(
        "SELECT id,name,instructions,status,revision,createdAt,updatedAt FROM agent_catalog WHERE id=?",
        id
      )
    )[0]
    return row ? Schema.decodeUnknownSync(AgentProfile)(row) : undefined
  }
  creation(id: AgentId) {
    const row = this.native(() =>
      this.db.all<unknown>("SELECT creation FROM agent_catalog WHERE id=?", id)
    )[0]
    return row ? Schema.decodeUnknownSync(Creation)(row).creation : undefined
  }
  activeCount() {
    const row = this.native(() =>
      this.db.all<unknown>(
        "SELECT count(*) AS n FROM agent_catalog WHERE status='active'"
      )
    )[0]
    return Schema.decodeUnknownSync(Count)(row).n
  }
  ensureHome(profile: AgentProfile) {
    this.native(() =>
      this.db.run(
        "INSERT OR IGNORE INTO agent_catalog (id,name,instructions,status,createdAt,updatedAt,creation) VALUES (?,?,?,'active',?,?,'legacy')",
        profile.id,
        profile.name,
        profile.instructions,
        profile.createdAt,
        profile.updatedAt
      )
    )
  }
  insert(profile: AgentProfile, creation: string) {
    this.native(() =>
      this.db.run(
        "INSERT INTO agent_catalog (id,name,instructions,status,createdAt,updatedAt,creation,revision) VALUES (?,?,?,?,?,?,?,?)",
        profile.id,
        profile.name,
        profile.instructions,
        profile.status,
        profile.createdAt,
        profile.updatedAt,
        creation,
        profile.revision
      )
    )
  }
  update(profile: AgentProfile) {
    this.native(() =>
      this.db.run(
        "UPDATE agent_catalog SET name=?,instructions=?,status=?,updatedAt=?,revision=? WHERE id=?",
        profile.name,
        profile.instructions,
        profile.status,
        profile.updatedAt,
        profile.revision,
        profile.id
      )
    )
  }
}
export const sqliteAgentCatalog = (db: Sqlite) =>
  Layer.unwrap(
    Effect.try({
      try: () => new SqliteAgentCatalog(db),
      catch: (cause) => {
        const agentStorageError =
          Schema.decodeUnknownOption(AgentStorageError)(cause)
        if (agentStorageError._tag === "Some") return agentStorageError.value
        throw cause
      },
    }).pipe(Effect.map(agentCatalogApplication))
  )
