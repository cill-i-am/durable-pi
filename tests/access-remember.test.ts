import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { database } from "./database"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessStorageError } from "../src/access/contracts"
import { AccessGate } from "../src/access/gate"
import { accessRequest } from "../src/access/adapters/http"

const catalog = () => [
  { name: "record", description: "Synthetic effect", mode: "ask" as const },
  { name: "other", description: "Other tool", mode: "ask" as const },
]
const intent = (id = crypto.randomUUID()) => ({
  id,
  turnId: "task",
  tool: "record",
  input: "{}",
})
const remember = { expectedPolicyRevision: 0 }

describe("persistent approval through the existing access owner", () => {
  it("migrates existing receipts without changing their authorization or result", () => {
    const db = database()
    db.run(
      "CREATE TABLE tool_operations (id TEXT PRIMARY KEY,turnId TEXT NOT NULL,tool TEXT NOT NULL,input TEXT NOT NULL,createdAt INTEGER NOT NULL,expiresAt INTEGER NOT NULL,status TEXT NOT NULL,grantRevision INTEGER NOT NULL,result TEXT,revision INTEGER NOT NULL DEFAULT 0)"
    )
    db.run(
      "INSERT INTO tool_operations VALUES ('legacy','task','record','{}',0,9999999999999,'done',0,'42',3)"
    )
    const store = new AccessStore(db, catalog)
    expect(store.get("legacy")).toMatchObject({
      status: "done",
      result: "42",
      revision: 3,
      decision: null,
    })
    expect(store.claim("legacy")).toEqual({ result: "42" })
    expect(store.policy("record").mode).toBe("ask")
  })
  it("persists one bot's grant and decision across restart, permits later inputs, and keeps receipt replay idempotent", async () => {
    const db = database()
    let store = new AccessStore(db, catalog)
    const first = intent()
    store.begin(first)
    store.decide(first.id, true, 0, remember)
    store = new AccessStore(db, catalog)
    expect(store.policy("record")).toMatchObject({ mode: "allow", revision: 1 })
    let effects = 0
    const gate = new AccessGate(store, () => true)
    const work = async () => ++effects
    expect(
      await Effect.runPromise(
        gate.run(
          first,
          Effect.tryPromise({ try: work, catch: (cause) => cause })
        )
      )
    ).toBe(1)
    expect(store.decide(first.id, true, 0, remember).status).toBe("done")
    expect(
      await Effect.runPromise(
        gate.run(
          first,
          Effect.tryPromise({ try: work, catch: (cause) => cause })
        )
      )
    ).toBe(1)
    expect(
      await Effect.runPromise(
        gate.run(
          { ...intent(), input: '{"next":true}' },
          Effect.tryPromise({ try: work, catch: (cause) => cause })
        )
      )
    ).toBe(2)
    expect(effects).toBe(2)
    expect(store.policy("record").revision).toBe(1)
    expect(store.policy("other").mode).toBe("ask")
    const otherBot = new AccessStore(database(), catalog)
    expect(otherBot.policy("record").mode).toBe("ask")
    expect(() => otherBot.decide(first.id, true, 0, remember)).toThrow(
      "no longer exists"
    )
    expect(() => store.begin({ ...first, turnId: "another-task" })).toThrow(
      "identity"
    )
  })

  it.each(["ask", "deny"] as const)(
    "a retried decision cannot undo a later %s policy",
    (mode) => {
      const db = database()
      const store = new AccessStore(db, catalog)
      const op = intent()
      store.begin(op)
      store.decide(op.id, true, 0, remember)
      store.claim(op.id)
      store.finish(op.id, '"saved"')
      store.update("record", 1, mode)
      const restarted = new AccessStore(db, catalog)
      restarted.decide(op.id, true, 0, remember)
      expect(restarted.policy("record")).toMatchObject({ mode, revision: 2 })
      expect(restarted.get(op.id)?.result).toBe('"saved"')
      if (mode === "ask") {
        const next = intent()
        restarted.begin(next)
        expect(restarted.claim(next.id)).toBe("pending")
      } else expect(() => restarted.begin(intent())).toThrow("denied")
    }
  )

  it("cannot upgrade a once-only decision or overwrite another tab's policy", () => {
    const store = new AccessStore(database(), catalog)
    const once = intent()
    store.begin(once)
    store.decide(once.id, true, 0)
    expect(() => store.decide(once.id, true, 0, remember)).toThrow("ended")
    const stale = intent()
    store.begin(stale)
    store.update("record", 0, "allow")
    store.update("record", 1, "ask")
    expect(() => store.decide(stale.id, true, 0, remember)).toThrow(
      "access changed"
    )
    expect(store.policy("record")).toMatchObject({ mode: "ask", revision: 2 })
    expect(store.get(stale.id)?.status).toBe("pending")
    store.decide(stale.id, true, 0, { expectedPolicyRevision: 2 })
    expect(store.policy("record")).toMatchObject({ mode: "allow", revision: 3 })
  })

  it.each(["cancel", "expire", "deny", "remove"])(
    "does not save a grant after %s",
    (scenario) => {
      let now = 1
      let available = true
      const store = new AccessStore(
        database(),
        () => (available ? catalog() : []),
        () => now
      )
      const op = intent()
      store.begin(op)
      if (scenario === "cancel") store.cancel(op.turnId)
      if (scenario === "expire") now += 16 * 60_000
      if (scenario === "deny") store.update("record", 0, "deny")
      if (scenario === "remove") available = false
      expect(() => store.decide(op.id, true, 0, remember)).toThrow()
      available = true
      expect(store.policy("record").mode).toBe(
        scenario === "deny" ? "deny" : "ask"
      )
    }
  )

  it("rolls back the policy if recording its approval fails", () => {
    const db = database()
    const store = new AccessStore(
      {
        ...db,
        run: (sql, ...bindings) => {
          if (sql.includes("decision=?,revision"))
            throw new Error("Synthetic write failure")
          db.run(sql, ...bindings)
        },
      },
      catalog
    )
    const op = intent()
    store.begin(op)
    expect(() => store.decide(op.id, true, 0, remember)).toThrow(
      AccessStorageError
    )
    expect(store.policy("record")).toMatchObject({ mode: "ask", revision: 0 })
    expect(store.get(op.id)).toMatchObject({
      status: "pending",
      revision: 0,
      decision: null,
    })
  })

  it("captures the actual dispatch grant for other pending calls while retaining cancellation and uncertain-outcome fences", async () => {
    const store = new AccessStore(database(), catalog)
    const first = intent(),
      pending = intent(),
      uncertain = intent()
    for (const op of [first, pending, uncertain]) store.begin(op)
    store.decide(first.id, true, 0, remember)
    expect(store.claim(pending.id, true)).toBe("execute")
    expect(store.get(pending.id)?.grantRevision).toBe(1)
    expect(store.claim(pending.id, true)).toBe("execute")
    store.claim(uncertain.id)
    expect(() => store.claim(uncertain.id)).toThrow("outcome is unknown")
    store.update("record", 1, "ask")
    expect(() => store.claim(pending.id, true)).toThrow(
      "changed after dispatch"
    )
    store.cancel(first.turnId)
    const gate = new AccessGate(store, () => false)
    let effects = 0
    await expect(
      Effect.runPromise(
        gate.run(
          first,
          Effect.tryPromise({
            try: async () => ++effects,
            catch: (cause) => cause,
          })
        )
      )
    ).rejects.toThrow("stopped")
    expect(effects).toBe(0)
  })

  it("validates and saves the scoped HTTP decision, and rejects missing revision, denial with remember, and archived writes", async () => {
    const store = new AccessStore(database(), catalog)
    const gate = new AccessGate(store, () => true)
    const op = intent()
    store.begin(op)
    const post = (body: unknown, writable = true) =>
      Effect.runPromise(
        accessRequest(
          gate,
          new Request("https://example.test/access/decide", {
            method: "POST",
            body: JSON.stringify(body),
          }),
          "access/decide",
          () => writable
        )
      )
    const base = { id: op.id, approve: true, expectedRevision: 0 }
    for (const body of [
      { ...base, remember: {} },
      { ...base, remember: { expectedPolicyRevision: -1 } },
      { ...base, approve: false, remember },
    ])
      expect((await post(body)).status).toBe(409)
    expect((await post({ ...base, remember }, false)).status).toBe(409)
    expect(store.policy("record").mode).toBe("ask")
    const response = await post({ ...base, remember })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tools: [
        { name: "record", mode: "allow", revision: 1 },
        { name: "other", mode: "ask" },
      ],
    })
    expect((await post({ ...base, remember })).status).toBe(200)
    expect(store.policy("record").revision).toBe(1)
  })
})
