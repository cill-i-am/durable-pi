import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { SqliteAgentCatalog } from "../src/agents/adapters/sqlite"
import { configureRecord } from "../src/agents/configuration.machine"
import { AgentId } from "../src/agents/domain"
import {
  advanceAgentRecord,
  newAgentRecord,
} from "../src/agents/profile.machine"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"

const profile = {
  id: Schema.decodeUnknownSync(AgentId)("00000000-0000-4000-8000-000000000001"),
  slug: "research",
  name: "Research",
  instructions: "Preserve this policy",
  status: "active" as const,
  revision: 4,
  createdAt: "created",
  updatedAt: "updated",
}

describe("agent profile and admission machines", () => {
  it("upgrades active and archived profiles and admission without changing identity, history or creation receipts", () => {
    const db = database({ migrate: false })
    const index = agentMigrationManifest.versions.findIndex(
      (version) => version.id === "20261023074535_amusing_union_jack"
    )
    expect(index).toBeGreaterThan(0)
    for (const version of agentMigrationManifest.versions.slice(0, index)) {
      for (const statement of version.statements) db.run(statement)
      db.run(
        "INSERT INTO __durable_pi_migrations VALUES (?,?)",
        version.id,
        version.checksum
      )
    }
    for (const [n, status] of ["active", "archived"].entries())
      db.run(
        "INSERT INTO agent_catalog(id,slug,name,instructions,status,revision,createdAt,updatedAt,creation) VALUES (?,?,?,?,?,?,?,?,?)",
        profile.id.replace(/1$/, String(n + 1)),
        `research-${n}`,
        profile.name,
        profile.instructions,
        status,
        profile.revision,
        profile.createdAt,
        profile.updatedAt,
        "raw creation receipt"
      )
    db.run(
      "INSERT INTO bot_configuration VALUES (1,'owner','Saved instructions')"
    )
    db.run("INSERT INTO bot_admission VALUES (1,7,'archived')")
    const profiles = db.all<Record<string, unknown>>(
      "SELECT * FROM agent_catalog ORDER BY id"
    )
    const admission = db.all<Record<string, unknown>>(
      "SELECT * FROM bot_admission"
    )
    const configuration = db.all("SELECT * FROM bot_configuration")
    Effect.runSync(migrateSqlite(db, { audit: true }))
    Effect.runSync(migrateSqlite(db, { audit: true }))
    expect(db.all("SELECT * FROM agent_catalog ORDER BY id")).toEqual(
      profiles.map((row) => ({ ...row, schemaVersion: 1, workflowVersion: 1 }))
    )
    expect(db.all("SELECT * FROM bot_admission")).toEqual(
      admission.map((row) => ({ ...row, schemaVersion: 1, workflowVersion: 1 }))
    )
    expect(db.all("SELECT * FROM bot_configuration")).toEqual(configuration)
    const ledger = new SqliteAgentCatalog(db)
    for (const record of Effect.runSync(ledger.list())) {
      expect(
        advanceAgentRecord(JSON.parse(JSON.stringify(record)), {
          type: "CREATE",
          creation: "raw creation receipt",
          active: 32,
        })
      ).toEqual(record)
      expect(
        advanceAgentRecord(record, {
          type: "UPDATE",
          now: "next",
          name: "Renamed",
          instructions: "Changed",
        })
      ).toMatchObject({
        status: record.status,
        revision: 5,
        id: record.id,
        slug: record.slug,
        createdAt: profile.createdAt,
        creation: record.creation,
      })
    }
    const store = new BotConfigurationStore(db)
    Effect.runSync(store.configure("owner", profile))
    expect(Effect.runSync(store.read())).toEqual({
      owner: "owner",
      instructions: "Saved instructions",
      revision: 7,
      status: "archived",
    })
    Effect.runSync(store.configure("owner", { ...profile, revision: 8 }))
    expect(Effect.runSync(store.read())).toMatchObject({
      status: "active",
      revision: 8,
    })
  })

  it.each(["schemaVersion", "workflowVersion"])(
    "rejects incompatible %s for profiles and admission without writing",
    (field) => {
      const db = database(),
        ledger = new SqliteAgentCatalog(db),
        store = new BotConfigurationStore(db)
      Effect.runSync(ledger.insert(newAgentRecord(profile, "creation", 0)))
      Effect.runSync(store.configure("owner", profile))
      db.run(`UPDATE agent_catalog SET ${field}=2`)
      db.run(`UPDATE bot_admission SET ${field}=2`)
      const before = db.all("SELECT * FROM agent_catalog")
      const admission = db.all("SELECT * FROM bot_admission")
      expect(() => Effect.runSync(ledger.read(profile.id))).toThrow(field)
      expect(() =>
        Effect.runSync(store.configure("owner", { ...profile, revision: 5 }))
      ).toThrow(field)
      expect(db.all("SELECT * FROM agent_catalog")).toEqual(before)
      expect(db.all("SELECT * FROM bot_admission")).toEqual(admission)
    }
  )

  it("rejects malformed events and restored states before changing authority", () => {
    const saved = newAgentRecord(profile, "creation", 0)
    expect(() =>
      advanceAgentRecord(saved, {
        type: "RESTORE",
        now: "next",
        active: "zero",
      } as never)
    ).toThrow()
    expect(() =>
      advanceAgentRecord(
        { ...saved, status: "future" },
        { type: "ARCHIVE", now: "next" }
      )
    ).toThrow()
    expect(() =>
      configureRecord(undefined, "owner", { ...profile, revision: -1 })
    ).toThrow()
    expect(() => configureRecord(undefined, 123 as never, profile)).toThrow()
    const archived = advanceAgentRecord(saved, {
      type: "ARCHIVE",
      now: "archived",
    })
    const restored = advanceAgentRecord(JSON.parse(JSON.stringify(archived)), {
      type: "RESTORE",
      now: "restored",
      active: 0,
    })
    expect(restored).toEqual({
      ...saved,
      status: "active",
      revision: 6,
      updatedAt: "restored",
    })
  })
})
