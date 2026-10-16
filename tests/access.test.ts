import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { database } from "./database"

const input = () => ({
  id: crypto.randomUUID(),
  turnId: crypto.randomUUID(),
  tool: "test",
  input: '{"value":"private"}',
})
const fixture = (mode: "allow" | "ask" | "deny" = "ask") =>
  new AccessStore(database(), () =>
    Effect.sync(() => [{ name: "test", description: "Test effect", mode }])
  )

describe("durable tool authorization", () => {
  it("starts a new approval round after policy changes and fences stale decisions", () => {
    const store = fixture(),
      intent = input()
    Effect.runSync(store.begin(intent))
    Effect.runSync(store.decide(intent.id, true, 0))
    Effect.runSync(store.update("test", 0, "allow"))
    Effect.runSync(store.update("test", 1, "ask"))
    expect(Effect.runSync(store.claim(intent.id))).toBe("pending")
    expect(Effect.runSync(store.get(intent.id))?.revision).toBe(2)
    expect(() => Effect.runSync(store.decide(intent.id, true, 0))).toThrow(
      "ended"
    )
    Effect.runSync(store.decide(intent.id, true, 2))
    expect(Effect.runSync(store.claim(intent.id))).toBe("execute")
  })
  it("waits for explicit approval, persists results, and replays without repeating effects", async () => {
    const store = fixture(),
      intent = input(),
      gate = new AccessGate(store, () => Effect.sync(() => true))
    let calls = 0
    const run = Effect.runPromise(
      gate.run(
        intent,
        Effect.tryPromise({
          try: async () => {
            calls++
            return { content: [{ type: "text", text: "done" }] }
          },
          catch: (cause) => cause,
        })
      )
    )
    expect(calls).toBe(0)
    expect(Effect.runSync(store.pending())[0]?.status).toBe("pending")
    Effect.runSync(
      store.decide(
        intent.id,
        true,
        Effect.runSync(store.get(intent.id))!.revision
      )
    )
    gate.notify()
    const result = await run
    expect(calls).toBe(1)
    expect(
      await Effect.runPromise(
        gate.run(
          intent,
          Effect.tryPromise({
            try: async () => {
              calls++
              return null
            },
            catch: (cause) => cause,
          })
        )
      )
    ).toEqual(result)
    expect(calls).toBe(1)
  })
  it("keeps revocation sticky and checks policy again after approval", () => {
    const store = fixture(),
      intent = input()
    Effect.runSync(store.begin(intent))
    Effect.runSync(
      store.decide(
        intent.id,
        true,
        Effect.runSync(store.get(intent.id))!.revision
      )
    )
    Effect.runSync(store.update("test", 0, "deny"))
    expect(() => Effect.runSync(store.claim(intent.id))).toThrow("revoked")
    Effect.runSync(store.update("test", 1, "allow"))
    expect(() => Effect.runSync(store.claim(intent.id))).toThrow("denied")
    expect(() => Effect.runSync(store.update("test", 0, "ask"))).toThrow(
      "changed"
    )
  })
  it("never repeats an operation interrupted after dispatch", () => {
    const store = fixture("allow"),
      intent = input()
    Effect.runSync(store.begin(intent))
    expect(Effect.runSync(store.claim(intent.id))).toBe("execute")
    expect(() => Effect.runSync(store.claim(intent.id))).toThrow(
      "outcome is unknown"
    )
    expect(Effect.runSync(store.get(intent.id))?.status).toBe("interrupted")
  })
  it.each(["expire", "revoke", "unchanged"])(
    "fences recoverable dispatches after %s",
    (scenario) => {
      let now = 1
      const store = new AccessStore(
          database(),
          () =>
            Effect.sync(() => [
              { name: "test", description: "Test", mode: "allow" },
            ]),
          () => now
        ),
        intent = input()
      Effect.runSync(store.begin(intent))
      expect(Effect.runSync(store.claim(intent.id, true))).toBe("execute")
      if (scenario === "expire") now += 16 * 60_000
      if (scenario === "revoke") {
        Effect.runSync(store.update("test", 0, "deny"))
        Effect.runSync(store.update("test", 1, "allow"))
      }
      if (scenario === "unchanged")
        expect(Effect.runSync(store.claim(intent.id, true))).toBe("execute")
      else {
        expect(() => Effect.runSync(store.claim(intent.id, true))).toThrow(
          scenario === "expire" ? "expired" : "changed"
        )
        expect(Effect.runSync(store.get(intent.id))?.status).toBe(
          scenario === "expire" ? "expired" : "denied"
        )
      }
    }
  )
  it("persists waiting intent across cancellation of the process and resumes from a durable decision", async () => {
    const store = fixture(),
      intent = input(),
      controller = new AbortController()
    const first = new AccessGate(store, () => Effect.sync(() => true))
    const interrupted = Effect.runPromise(
      first.run(
        intent,
        Effect.tryPromise({
          try: async () => "must not run",
          catch: (cause) => cause,
        })
      ),
      { signal: controller.signal }
    )
    controller.abort()
    await expect(interrupted).rejects.toBeDefined()
    expect(Effect.runSync(store.get(intent.id))?.status).toBe("pending")
    Effect.runSync(
      store.decide(
        intent.id,
        true,
        Effect.runSync(store.get(intent.id))!.revision
      )
    )
    const restarted = new AccessGate(store, () => Effect.sync(() => true))
    expect(
      await Effect.runPromise(
        restarted.run(
          intent,
          Effect.tryPromise({
            try: async () => "resumed",
            catch: (cause) => cause,
          })
        )
      )
    ).toBe("resumed")
  })
  it("expires approvals and prevents approval after stop", () => {
    let now = 1
    const store = new AccessStore(
      database(),
      () =>
        Effect.sync(() => [{ name: "test", description: "Test", mode: "ask" }]),
      () => now
    )
    const intent = input()
    Effect.runSync(store.begin(intent))
    now = 15 * 60_000 + 2
    expect(() =>
      Effect.runSync(
        store.decide(
          intent.id,
          true,
          Effect.runSync(store.get(intent.id))!.revision
        )
      )
    ).toThrow("ended")
    const next = input()
    Effect.runSync(store.begin(next))
    Effect.runSync(store.cancel(next.turnId))
    expect(() =>
      Effect.runSync(
        store.decide(
          next.id,
          true,
          Effect.runSync(store.get(next.id))!.revision
        )
      )
    ).toThrow("ended")
  })
})
