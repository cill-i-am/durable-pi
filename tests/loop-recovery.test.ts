import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  initialRecovery,
  observeRound,
  type Observation,
} from "../src/conversations/recovery"
import { recoveryFingerprint } from "../src/conversations/adapters/crypto"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

const call = (id: number, options: Partial<Observation> = {}): Observation => ({
  resultId: id,
  invocation: `task:${id}`,
  tool: "read_file",
  fingerprint: "same",
  outcome: "failure",
  receiptId: String(id),
  ...options,
})
const warned = () =>
  observeRound(initialRecovery("a"), "a", "a", [call(1), call(2), call(3)])

describe("deterministic run recovery", () => {
  it("canonicalizes keys without changing array order and stores only hashes", async () => {
    const a = await recoveryFingerprint({
      tool: "read",
      args: { b: [1, 2], a: "private-input" },
      category: "error",
    })
    expect(a).toBe(
      await recoveryFingerprint({
        category: "error",
        args: { a: "private-input", b: [1, 2] },
        tool: "read",
      })
    )
    expect(a).not.toBe(
      await recoveryFingerprint({
        tool: "read",
        args: { b: [2, 1], a: "private-input" },
        category: "error",
      })
    )
    expect(a).toMatch(/^[a-f0-9]{64}$/)
  })
  it("warns at three and stops at five distinct matching failures", () => {
    const state = warned()
    expect(state.view).toMatchObject({
      phase: "recovering",
      failures: 3,
      remaining: 3,
    })
    expect(observeRound(state, "a", "a", [call(3)])).toEqual(state)
    const next = observeRound(state, "a", "a", [call(4)])
    expect(next.view).toMatchObject({
      phase: "recovering",
      failures: 4,
      remaining: 2,
    })
    expect(observeRound(next, "a", "a", [call(5)]).view).toMatchObject({
      phase: "blocked",
      failures: 5,
    })
  })
  it("offers feedback even when the first parallel round exceeds the threshold", () => {
    const state = observeRound(
      initialRecovery("a"),
      "a",
      "a",
      Array.from({ length: 8 }, (_, i) => call(i + 1))
    )
    expect(state.view).toMatchObject({ phase: "recovering", remaining: 3 })
    expect(observeRound(state, "a", "a", [call(9)]).view?.phase).toBe("blocked")
  })
  it("allows a corrected approach but never treats it as task completion", () => {
    const next = observeRound(warned(), "a", "a", [
      call(4, { outcome: "success", fingerprint: "corrected" }),
    ])
    expect(next.view?.phase).toBe("recovered")
    expect(next.view?.detail).toContain("not proof")
    expect(next.buckets[0]?.count).toBe(3)
  })
  it("bounds failed recovery even when subsequent arguments keep changing", () => {
    const next = observeRound(warned(), "a", "a", [
      call(4, { fingerprint: "new1" }),
      call(5, { fingerprint: "new2" }),
      call(6, { fingerprint: "new3" }),
    ])
    expect(next.view).toMatchObject({ phase: "blocked", remaining: 0 })
  })
  it("polling and approval waits neither consume allowance nor claim progress", () => {
    const state = warned()
    const next = observeRound(state, "a", "a", [
      call(4, { outcome: "poll" }),
      call(5, { outcome: "ignored" }),
    ])
    expect(next.view).toEqual(state.view)
  })
  it.each(["denied", "uncertain"] as const)(
    "%s stays authoritative through steering",
    (outcome) => {
      const next = observeRound(warned(), "b", "a", [call(4, { outcome })])
      expect(next.view).toMatchObject({ phase: "blocked", reason: outcome })
      expect(
        observeRound(next, "c", "c", [call(5, { outcome: "success" })])
      ).toEqual(next)
      expect(next.view?.detail).not.toContain("another permitted approach")
    }
  )
  it("new steering resets failure recovery and ignores old in-flight round errors", () => {
    const next = observeRound(warned(), "new-requirement", "a", [call(4)])
    expect(next.view).toBeNull()
    expect(next.buckets).toEqual([])
    expect(next.cursor).toBe(4)
    expect(
      observeRound(next, "new-requirement", "new-requirement", [call(5)])
        .buckets[0]?.count
    ).toBe(1)
  })
  it("bounds stored fingerprints and deduplicates logical invocations in a round", () => {
    const next = observeRound(
      initialRecovery("a"),
      "a",
      "a",
      Array.from({ length: 100 }, (_, i) =>
        call(i + 1, { fingerprint: `hash${i}` })
      )
    )
    expect(next.buckets).toHaveLength(32)
    expect(
      observeRound(initialRecovery("a"), "a", "a", [
        call(1),
        call(2, { invocation: "task:1" }),
      ]).buckets[0]?.count
    ).toBe(1)
  })
})

describe("run recovery persistence and ownership", () => {
  function setup() {
    const db = database()
    const turns = new ConversationStore(db, {
      model: "faux-1",
      thinking: "off",
    })
    const id = crypto.randomUUID()
    Effect.runSync(turns.admit({ operationId: id, text: "Synthetic task" }))
    Effect.runSync(turns.saveSession(id, "7"))
    db.run("UPDATE chat_turns SET status='running' WHERE id=?", id)
    return { db, turns, id, store: new RunRecoveryStore(db) }
  }
  it("reopens without recounting committed results; isolates task, session and bot", () => {
    const { db, id, store, turns } = setup()
    Effect.runSync(
      store.observe(id, "7", "a", "a", [call(1), call(2), call(3)])
    )
    const reopened = new RunRecoveryStore(db)
    expect(
      Effect.runSync(reopened.observe(id, "7", "a", "a", [call(3)]))?.view
        ?.failures
    ).toBe(3)
    expect(
      Effect.runSync(reopened.observe(id, "other-session", "a", "a", [call(4)]))
    ).toBeUndefined()
    const second = crypto.randomUUID()
    Effect.runSync(
      turns.admit({ operationId: second, text: "Different request" })
    )
    expect(Effect.runSync(reopened.get(second))).toBeUndefined()
    expect(Effect.runSync(setup().store.get(id))).toBeUndefined()
  })
  it("cancellation and a completed run reject observations without reopening", () => {
    const { db, id, store } = setup()
    Effect.runSync(
      store.observe(id, "7", "a", "a", [call(1), call(2), call(3)])
    )
    for (const status of ["stopping", "cancelled", "done", "failed"]) {
      db.run("UPDATE chat_turns SET status=? WHERE id=?", status, id)
      expect(
        Effect.runSync(store.observe(id, "7", "a", "a", [call(4)]))
      ).toBeUndefined()
      expect(Effect.runSync(store.get(id))?.view?.failures).toBe(3)
    }
  })
  it("rejects invalid policy configuration", () => {
    expect(
      () =>
        new RunRecoveryStore(database(), {
          warnAfter: 3,
          stopAfter: 2,
          recoveryAttempts: 3,
        })
    ).toThrow()
  })
})

it("an uncertain or denied effect in a parallel round outranks a repetition stop", () => {
  for (const outcome of ["denied", "uncertain"] as const) {
    const state = observeRound(warned(), "a", "a", [
      call(4),
      call(5),
      call(6, { outcome }),
    ])
    expect(state.view).toMatchObject({
      reason: outcome,
      resultId: 6,
      phase: "blocked",
    })
  }
})
