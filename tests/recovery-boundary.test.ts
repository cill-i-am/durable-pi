import { expect, it } from "@effect/vitest"
import { Cause, Clock, Effect, Exit } from "effect"
import { RunRecoveryStore } from "../src/conversations/adapters/sqlite-recovery"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { webCryptoRecoveryFingerprint } from "../src/conversations/adapters/crypto"
import { makeRunRecovery } from "../src/conversations/recovery-service"
import {
  recoveryOutcome,
  initialRecovery,
  type Observation,
} from "../src/conversations/recovery"
import { database } from "./database"
import { makeConversations } from "../src/conversations/service"

const failure = (id: number): Observation => ({
  resultId: id,
  invocation: `task:${id}`,
  fingerprint: "hash",
  tool: "read",
  outcome: "failure",
  receiptId: null,
})
function fixture() {
  const db = database(),
    turns = new ConversationStore(db, { model: "test", thinking: "off" })
  turns.admit({ operationId: "root", text: "hello" })
  turns.submitted("root", "session")
  const ledger = new RunRecoveryStore(db)
  const recovery = makeRunRecovery(ledger, webCryptoRecoveryFingerprint)
  return { db, turns, ledger, recovery }
}
it.effect(
  "rejects corrupt status projections as defects without exposing recovery payloads",
  () =>
    Effect.gen(function* () {
      const f = fixture(),
        conversations = makeConversations(f.turns)
      for (const recovery of [
        "not JSON",
        JSON.stringify({
          view: { phase: "invalid" },
          privateData: "private output",
        }),
      ]) {
        f.db.run("UPDATE chat_turns SET recovery=? WHERE id='root'", recovery)
        const exit = yield* conversations.statusTurns().pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      }
      f.db.run(
        "UPDATE chat_turns SET recovery=? WHERE id='root'",
        JSON.stringify({
          view: { phase: "blocked" },
          privateData: "private output",
        })
      )
      expect(JSON.stringify(yield* conversations.statusTurns())).not.toContain(
        "private output"
      )
    })
)
it.effect(
  "pins the historical fingerprint and keeps canonicalization failures as defects",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      expect(
        yield* f.recovery.epoch({
          tool: "read",
          args: { b: [1, 2], a: "private-input" },
          category: "error",
        })
      ).toBe("466b5fc10be2ba5645665f9aa5c1b056bec236785c80efa4b38e1d90c22f8e67")
      const exit = yield* f.recovery.epoch(1n).pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
    })
)
it.effect(
  "checks the current native source immediately before recovery writes and uses Clock for history",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      expect(
        yield* f.recovery.observe(
          "root",
          "session",
          "epoch",
          "epoch",
          [failure(1)],
          () => undefined
        )
      ).toBeUndefined()
      expect(yield* f.recovery.get("root")).toBeUndefined()
      const now = yield* Clock.currentTimeMillis
      const state = yield* f.recovery.observe(
        "root",
        "session",
        "epoch",
        "epoch",
        [failure(1), failure(2), failure(3)],
        () => "epoch"
      )
      expect(state?.view?.phase).toBe("recovering")
      expect(
        f.db.all<{ at: string }>("SELECT at FROM chat_recovery_history")[0]?.at
      ).toBe(new Date(now).toISOString())
    })
)
it.effect(
  "ignores stale-request failures while still enforcing denied authority",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const observations = [failure(1), failure(2), failure(3)]
      const stale = yield* f.recovery.observe(
        "root",
        "session",
        "new epoch",
        "old epoch",
        observations,
        () => "stale-request"
      )
      expect(stale?.view).toBeNull()
      expect(stale?.buckets).toEqual([])
      const denied = yield* f.recovery.observe(
        "root",
        "session",
        "new epoch",
        "old epoch",
        [{ ...failure(4), outcome: "denied" }],
        () => "stale-request"
      )
      expect(denied?.view).toMatchObject({ phase: "blocked", reason: "denied" })
    })
)
it.effect("rolls recovery state back when history insertion fails", () =>
  Effect.gen(function* () {
    const f = fixture()
    f.db.run(
      "CREATE TRIGGER reject_history BEFORE INSERT ON chat_recovery_history BEGIN SELECT RAISE(ABORT,'history failed'); END"
    )
    expect(
      yield* f.recovery
        .observe("root", "session", "epoch", "epoch", [
          failure(1),
          failure(2),
          failure(3),
        ])
        .pipe(Effect.result)
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConversationStorageError" },
    })
    expect(yield* f.recovery.get("root")).toBeUndefined()
    expect(f.db.all("SELECT * FROM chat_recovery_history")).toEqual([])
  })
)
it.effect(
  "validates historical recovery while retaining extra metadata and rejects corruption as a defect",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      f.db.run(
        "UPDATE chat_turns SET recovery=? WHERE id='root'",
        JSON.stringify({
          ...initialRecovery("legacy epoch"),
          historicalMarker: "retained",
        })
      )
      expect(yield* f.recovery.get("root")).toMatchObject({
        version: 1,
        epoch: "legacy epoch",
        historicalMarker: "retained",
      })
      for (const bad of [
        { ...initialRecovery("epoch"), version: 2 },
        { ...initialRecovery("epoch"), cursor: -1 },
        {
          ...initialRecovery("epoch"),
          buckets: [{ fingerprint: "hash", count: "bad" }],
        },
      ]) {
        f.db.run(
          "UPDATE chat_turns SET recovery=? WHERE id='root'",
          JSON.stringify(bad)
        )
        const exit = yield* f.recovery.get("root").pipe(Effect.exit)
        expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
        expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
      }
    })
)
it.effect(
  "preserves guard programming failures as defects and database failures as typed errors",
  () =>
    Effect.gen(function* () {
      const f = fixture()
      const exit = yield* f.recovery
        .observe("root", "session", "epoch", "epoch", [], () => {
          throw new Error("guard bug")
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      f.db.all = () => {
        throw new Error("driver unavailable")
      }
      expect(yield* f.recovery.get("root").pipe(Effect.result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ConversationStorageError" },
      })
    })
)
it("gives durable uncertainty and denial precedence over transient diagnostics", () => {
  const base = {
    diagnostics: ["aborted"],
    isError: true,
    tool: "read",
    deniedPolicy: false,
  }
  for (const receiptStatus of ["running", "interrupted"])
    expect(recoveryOutcome({ ...base, receiptStatus }).outcome).toBe(
      "uncertain"
    )
  for (const receiptStatus of ["denied", "expired"])
    expect(recoveryOutcome({ ...base, receiptStatus }).outcome).toBe("denied")
  for (const receiptStatus of ["pending", "approved", "cancelled"])
    expect(
      recoveryOutcome({ ...base, diagnostics: ["blocked"], receiptStatus })
        .outcome
    ).toBe("ignored")
  expect(
    recoveryOutcome({ ...base, diagnostics: [], deniedPolicy: true }).outcome
  ).toBe("denied")
  expect(
    recoveryOutcome({ ...base, diagnostics: ["invalid_arguments"] })
  ).toEqual({ outcome: "failure", category: "invalid_arguments" })
  expect(
    recoveryOutcome({
      ...base,
      diagnostics: [],
      isError: false,
      tool: "check_bot_task",
    }).outcome
  ).toBe("poll")
})
