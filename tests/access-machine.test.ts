import { Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import { initialTransition, transition } from "xstate"

import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import {
  advanceOperation,
  operationCommands,
} from "../src/access/operation.machine"
import { agentMigrationManifest } from "../src/storage/migration-manifest"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"
import { preparationMachine } from "./lifecycle/preparation.machine"

const intent = { id: "operation", turnId: "turn", tool: "test", input: "{}" }
const catalog = () =>
  Effect.succeed([{ name: "test", description: "Test", mode: "ask" as const }])
const policy = {
  name: "test",
  description: "Test",
  mode: "ask" as const,
  revision: 0,
}

describe("Access machine persistence and event admission", () => {
  it("converts every legacy state without changing identities, revisions, decisions, grants or receipts", () => {
    const db = database({ migrate: false })
    for (const version of agentMigrationManifest.versions.slice(0, -1)) {
      for (const statement of version.statements) db.run(statement)
      db.run(
        "INSERT INTO __durable_pi_migrations VALUES (?,?)",
        version.id,
        version.checksum
      )
    }
    const statuses = [
      "pending",
      "approved",
      "running",
      "done",
      "denied",
      "cancelled",
      "expired",
      "interrupted",
    ]
    for (const status of statuses) {
      db.run(
        "INSERT INTO tool_operations(id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision,decision) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        status,
        "turn",
        "test",
        "{}",
        1,
        9999999999999,
        status,
        0,
        status === "done" ? '"kept"' : null,
        3,
        "saved-decision"
      )
      db.run(
        "INSERT INTO tool_operation_history(operationId,revision,status,at) VALUES (?,?,?,?)",
        status,
        3,
        status,
        1
      )
    }
    db.run("INSERT INTO tool_grants VALUES ('test','ask',0)")
    const before = db.all<Record<string, unknown>>(
      "SELECT * FROM tool_operations ORDER BY id"
    )
    const history = db.all("SELECT * FROM tool_operation_history")
    Effect.runSync(migrateSqlite(db, { audit: true }))
    Effect.runSync(migrateSqlite(db, { audit: true }))
    expect(db.all("SELECT * FROM tool_operations ORDER BY id")).toEqual(
      before.map((row) => ({ ...row, schemaVersion: 1, workflowVersion: 1 }))
    )
    expect(db.all("SELECT * FROM tool_operation_history")).toEqual(history)
    const store = new AccessStore(db, catalog)
    for (const status of statuses) {
      const operation = Effect.runSync(store.get(status))!
      expect(
        advanceOperation(JSON.parse(JSON.stringify(operation)), {
          type: "BEGIN",
          intent: { ...intent, id: status },
          pending: 0,
          runnable: true,
          policy: null,
        })
      ).toEqual({ operation, commands: [] })
    }
    expect(Effect.runSync(store.claim("pending"))).toBe("pending")
    expect(Effect.runSync(store.claim("approved"))).toBe("execute")
    expect(Effect.runSync(store.claim("running", true))).toBe("execute")
    expect(Effect.runSync(store.claim("done"))).toEqual({ result: '"kept"' })
    for (const status of ["denied", "cancelled", "expired", "interrupted"])
      expect(() => Effect.runSync(store.claim(status, true))).toThrow(status)
  })

  it.each(["schemaVersion", "workflowVersion"])(
    "rejects an incompatible %s without modifying storage",
    (field) => {
      const db = database(),
        store = new AccessStore(db, catalog)
      Effect.runSync(store.begin(intent))
      db.run(`UPDATE tool_operations SET ${field}=2`)
      const before = db.all("SELECT * FROM tool_operations")
      expect(() => Effect.runSync(store.claim(intent.id))).toThrow(field)
      expect(db.all("SELECT * FROM tool_operations")).toEqual(before)
    }
  )

  it("replays a saved decision even when the tool catalog is unavailable", () => {
    const db = database(),
      store = new AccessStore(db, catalog)
    Effect.runSync(store.begin(intent))
    const approved = Effect.runSync(store.decide(intent.id, true, 0))
    const unavailable = new AccessStore(db, () =>
      Effect.die("Catalog unavailable")
    )
    expect(Effect.runSync(unavailable.decide(intent.id, true, 0))).toEqual(
      approved
    )
  })

  it("rejects malformed events and unsupported effect descriptors before persistence", () => {
    const store = new AccessStore(database(), catalog)
    const operation = Effect.runSync(store.begin(intent))
    expect(() =>
      advanceOperation(operation, {
        type: "CLAIM",
        policy,
        runnable: true,
        now: 0,
        recoverable: "yes",
      } as never)
    ).toThrow()
    expect(() =>
      advanceOperation({ ...operation, status: "future" }, { type: "CANCEL" })
    ).toThrow()
    const [idle] = initialTransition(preparationMachine)
    expect(() =>
      operationCommands(
        transition(preparationMachine, idle, { type: "START" })[1]
      )
    ).toThrow("Unsupported Access operation effect")
    expect(Effect.runSync(store.get(intent.id))).toEqual(operation)
  })

  it("retains committed uncertainty after checkpoint failure and never authorizes another nonrecoverable effect", async () => {
    const db = database(),
      store = new AccessStore(db, catalog),
      gate = new AccessGate(store, () => Effect.succeed(true))
    Effect.runSync(store.begin(intent))
    Effect.runSync(store.decide(intent.id, true, 0))
    db.run(
      "CREATE TRIGGER reject_receipt BEFORE UPDATE OF result ON tool_operations WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'checkpoint failure'); END"
    )
    let calls = 0
    const work = Effect.sync(() => ++calls)
    const failed = await Effect.runPromise(Effect.exit(gate.run(intent, work)))
    expect(Exit.isFailure(failed)).toBe(true)
    expect(Effect.runSync(store.get(intent.id))?.status).toBe("running")
    db.run("DROP TRIGGER reject_receipt")
    const restored = new AccessGate(new AccessStore(db, catalog), () =>
      Effect.succeed(true)
    )
    await expect(Effect.runPromise(restored.run(intent, work))).rejects.toThrow(
      "outcome is unknown"
    )
    expect(calls).toBe(1)
    expect(Effect.runSync(store.get(intent.id))).toMatchObject({
      status: "interrupted",
      result: null,
    })
    Effect.runSync(store.finish(intent.id, '"late"'))
    expect(Effect.runSync(store.get(intent.id))).toMatchObject({
      status: "interrupted",
      result: null,
    })
  })
})
