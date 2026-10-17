import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { accessRequest } from "../src/access/adapters/http"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessStorageError } from "../src/access/contracts"
import { AccessGate } from "../src/access/gate"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"

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
  it("reopens committed receipts without changing their authorization or result", () => {
    const db = database()
    db.run(
      "INSERT INTO tool_operations(id,turnId,tool,input,createdAt,expiresAt,status,grantRevision,result,revision) VALUES ('legacy','task','record','{}',0,9999999999999,'done',0,'42',3)"
    )
    Effect.runSync(migrateSqlite(db))
    const store = new AccessStore(db, () => Effect.sync(() => catalog()))
    expect(Effect.runSync(store.get("legacy"))).toMatchObject({
      status: "done",
      result: "42",
      revision: 3,
      decision: null,
    })
    expect(Effect.runSync(store.claim("legacy"))).toEqual({ result: "42" })
    expect(Effect.runSync(store.policy("record")).mode).toBe("ask")
  })
  it("persists one bot's grant and decision across restart, permits later inputs, and keeps receipt replay idempotent", async () => {
    const db = database()
    let store = new AccessStore(db, () => Effect.sync(() => catalog()))
    const first = intent()
    Effect.runSync(store.begin(first))
    Effect.runSync(store.decide(first.id, true, 0, remember))
    store = new AccessStore(db, () => Effect.sync(() => catalog()))
    expect(Effect.runSync(store.policy("record"))).toMatchObject({
      mode: "allow",
      revision: 1,
    })
    let effects = 0
    const gate = new AccessGate(store, () => Effect.sync(() => true))
    const work = async () => ++effects
    expect(
      await Effect.runPromise(
        gate.run(
          first,
          Effect.tryPromise({ try: work, catch: (cause) => cause })
        )
      )
    ).toBe(1)
    expect(
      Effect.runSync(store.decide(first.id, true, 0, remember)).status
    ).toBe("done")
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
    expect(Effect.runSync(store.policy("record")).revision).toBe(1)
    expect(Effect.runSync(store.policy("other")).mode).toBe("ask")
    const otherBot = new AccessStore(database(), () =>
      Effect.sync(() => catalog())
    )
    expect(Effect.runSync(otherBot.policy("record")).mode).toBe("ask")
    expect(() =>
      Effect.runSync(otherBot.decide(first.id, true, 0, remember))
    ).toThrow("no longer exists")
    expect(() =>
      Effect.runSync(store.begin({ ...first, turnId: "another-task" }))
    ).toThrow("identity")
  })

  it.each(["ask", "deny"] as const)(
    "a retried decision cannot undo a later %s policy",
    (mode) => {
      const db = database()
      const store = new AccessStore(db, () => Effect.sync(() => catalog()))
      const op = intent()
      Effect.runSync(store.begin(op))
      Effect.runSync(store.decide(op.id, true, 0, remember))
      Effect.runSync(store.claim(op.id))
      Effect.runSync(store.finish(op.id, '"saved"'))
      Effect.runSync(store.update("record", 1, mode))
      const restarted = new AccessStore(db, () => Effect.sync(() => catalog()))
      Effect.runSync(restarted.decide(op.id, true, 0, remember))
      expect(Effect.runSync(restarted.policy("record"))).toMatchObject({
        mode,
        revision: 2,
      })
      expect(Effect.runSync(restarted.get(op.id))?.result).toBe('"saved"')
      if (mode === "ask") {
        const next = intent()
        Effect.runSync(restarted.begin(next))
        expect(Effect.runSync(restarted.claim(next.id))).toBe("pending")
      } else
        expect(() => Effect.runSync(restarted.begin(intent()))).toThrow(
          "denied"
        )
    }
  )

  it("cannot upgrade a once-only decision or overwrite another tab's policy", () => {
    const store = new AccessStore(database(), () =>
      Effect.sync(() => catalog())
    )
    const once = intent()
    Effect.runSync(store.begin(once))
    Effect.runSync(store.decide(once.id, true, 0))
    expect(() =>
      Effect.runSync(store.decide(once.id, true, 0, remember))
    ).toThrow("ended")
    const stale = intent()
    Effect.runSync(store.begin(stale))
    Effect.runSync(store.update("record", 0, "allow"))
    Effect.runSync(store.update("record", 1, "ask"))
    expect(() =>
      Effect.runSync(store.decide(stale.id, true, 0, remember))
    ).toThrow("access changed")
    expect(Effect.runSync(store.policy("record"))).toMatchObject({
      mode: "ask",
      revision: 2,
    })
    expect(Effect.runSync(store.get(stale.id))?.status).toBe("pending")
    Effect.runSync(
      store.decide(stale.id, true, 0, { expectedPolicyRevision: 2 })
    )
    expect(Effect.runSync(store.policy("record"))).toMatchObject({
      mode: "allow",
      revision: 3,
    })
  })

  it.each(["cancel", "expire", "deny", "remove"])(
    "does not save a grant after %s",
    (scenario) => {
      let now = 1
      let available = true
      const store = new AccessStore(
        database(),
        () => Effect.sync(() => (available ? catalog() : [])),
        () => now
      )
      const op = intent()
      Effect.runSync(store.begin(op))
      if (scenario === "cancel") Effect.runSync(store.cancel(op.turnId))
      if (scenario === "expire") now += 16 * 60_000
      if (scenario === "deny") Effect.runSync(store.update("record", 0, "deny"))
      if (scenario === "remove") available = false
      expect(() =>
        Effect.runSync(store.decide(op.id, true, 0, remember))
      ).toThrow()
      available = true
      expect(Effect.runSync(store.policy("record")).mode).toBe(
        scenario === "deny" ? "deny" : "ask"
      )
    }
  )

  it("rolls back the policy if recording its approval fails", () => {
    const db = database()
    db.run(
      "CREATE TRIGGER reject_tool_decision BEFORE UPDATE OF decision ON tool_operations BEGIN SELECT RAISE(ABORT,'Synthetic write failure'); END"
    )
    const store = new AccessStore(db, () => Effect.sync(catalog))
    const op = intent()
    Effect.runSync(store.begin(op))
    expect(() =>
      Effect.runSync(store.decide(op.id, true, 0, remember))
    ).toThrow(AccessStorageError)
    expect(Effect.runSync(store.policy("record"))).toMatchObject({
      mode: "ask",
      revision: 0,
    })
    expect(Effect.runSync(store.get(op.id))).toMatchObject({
      status: "pending",
      revision: 0,
      decision: null,
    })
  })

  it("captures the actual dispatch grant for other pending calls while retaining cancellation and uncertain-outcome fences", async () => {
    const store = new AccessStore(database(), () =>
      Effect.sync(() => catalog())
    )
    const first = intent(),
      pending = intent(),
      uncertain = intent()
    for (const op of [first, pending, uncertain])
      Effect.runSync(store.begin(op))
    Effect.runSync(store.decide(first.id, true, 0, remember))
    expect(Effect.runSync(store.claim(pending.id, true))).toBe("execute")
    expect(Effect.runSync(store.get(pending.id))?.grantRevision).toBe(1)
    expect(Effect.runSync(store.claim(pending.id, true))).toBe("execute")
    Effect.runSync(store.claim(uncertain.id))
    expect(() => Effect.runSync(store.claim(uncertain.id))).toThrow(
      "outcome is unknown"
    )
    Effect.runSync(store.update("record", 1, "ask"))
    expect(() => Effect.runSync(store.claim(pending.id, true))).toThrow(
      "changed after dispatch"
    )
    Effect.runSync(store.cancel(first.turnId))
    const gate = new AccessGate(store, () => Effect.sync(() => false))
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
    const store = new AccessStore(database(), () =>
      Effect.sync(() => catalog())
    )
    const gate = new AccessGate(store, () => Effect.sync(() => true))
    const op = intent()
    Effect.runSync(store.begin(op))
    const post = (body: unknown, writable = true) =>
      Effect.runPromise(
        accessRequest(
          gate,
          new Request("https://example.test/access/decide", {
            method: "POST",
            body: JSON.stringify(body),
          }),
          "access/decide",
          () => Effect.sync(() => writable)
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
    expect(Effect.runSync(store.policy("record")).mode).toBe("ask")
    const response = await post({ ...base, remember })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      tools: [
        { name: "record", mode: "allow", revision: 1 },
        { name: "other", mode: "ask" },
      ],
    })
    expect((await post({ ...base, remember })).status).toBe(200)
    expect(Effect.runSync(store.policy("record")).revision).toBe(1)
  })
})
