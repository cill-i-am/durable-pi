import { expect, it } from "vitest"
import { Cause, Effect, Exit } from "effect"
import * as Domain from "../src/conversations/domain"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { makeConversations } from "../src/conversations/service"
import type { Turn } from "../src/conversations/turns"
import { database } from "./database"

const turn: Turn = {
  id: "root",
  text: "Request",
  status: "running",
  answer: "",
  error: null,
  created_at: "2026-10-10",
  session_id: "session",
  prompt: "Prompt",
  parent_id: null,
  mode: "followUp",
  delivery: "accepted",
  model: "test",
  thinking: "off",
  revision: 0,
  creation: null,
  attachments: [],
  input: [],
  skills: [],
  skill_context: "",
}
it("cannot reopen terminal turns through preparation, submission or completion at any revision", () => {
  for (const status of ["done", "failed", "cancelled"] as const) {
    for (const revision of [0, 1, 10, 99]) {
      const current = { ...turn, status, revision }
      expect(Domain.canPrepare(current)).toBe(false)
      expect(Domain.canSubmit(current)).toBe(false)
      expect(
        Domain.finishTransition(
          current,
          current,
          [current],
          [{ id: current.id, delivery: "answered" }],
          "Later",
          null
        )
      ).toBeUndefined()
      expect(Domain.stopTransition(current, current)).toBeUndefined()
    }
  }
})
it("requires the current revision and every member while retaining answered children after stop", () => {
  const child = { ...turn, id: "child", parent_id: turn.id }
  const current = { ...turn, status: "stopping" as const, revision: 1 }
  const outcomes = [
    { id: turn.id, delivery: "answered" as const },
    { id: child.id, delivery: "answered" as const },
  ]
  expect(
    Domain.finishTransition(
      turn,
      current,
      [current, child],
      outcomes,
      "Partial",
      "Failure"
    )
  ).toBeUndefined()
  expect(
    Domain.finishTransition(
      current,
      current,
      [current, child],
      outcomes.slice(0, 1),
      "Partial",
      "Failure"
    )
  ).toBeUndefined()
  expect(
    Domain.finishTransition(
      current,
      current,
      [current, child],
      outcomes,
      "Partial",
      "Failure"
    )
  ).toMatchObject({
    members: [
      { id: turn.id, status: "cancelled" },
      { id: child.id, status: "done" },
    ],
    error: null,
  })
})
it("rolls back a steer and its root revision when the root update fails", async () => {
  const db = database(),
    ledger = new ConversationStore(db, { model: "test", thinking: "off" }),
    service = makeConversations(ledger)
  expect(ledger.transactionGroup).toBe(db)
  const root = ledger.admit({ operationId: "root", text: "Request" }).turn
  db.run(
    "CREATE TRIGGER reject_steer BEFORE UPDATE ON chat_turns WHEN NEW.id='root' AND NEW.revision>OLD.revision BEGIN SELECT RAISE(ABORT,'revision failure'); END"
  )
  const result = await Effect.runPromise(
    service
      .admit({ operationId: "steer", text: "Correction", mode: "steer" })
      .pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConversationStorageError" },
  })
  expect(ledger.get("steer")).toBeUndefined()
  expect(ledger.get(root.id)?.revision).toBe(root.revision)
})
it("rolls back all member outcomes when one completion update fails", async () => {
  const db = database(),
    ledger = new ConversationStore(db, { model: "test", thinking: "off" }),
    service = makeConversations(ledger)
  ledger.admit({ operationId: "root", text: "Request" })
  ledger.admit({ operationId: "child", text: "Correction", mode: "steer" })
  ledger.submitted("root", "session")
  ledger.submitted("child", "session")
  const root = ledger.get("root")!
  db.run(
    "CREATE TRIGGER reject_child_finish BEFORE UPDATE ON chat_turns WHEN NEW.id='child' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'completion failure'); END"
  )
  const result = await Effect.runPromise(
    service
      .finish(
        root,
        [
          { id: "root", delivery: "answered" },
          { id: "child", delivery: "answered" },
        ],
        "Answer",
        null
      )
      .pipe(Effect.result)
  )
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ConversationStorageError" },
  })
  expect(ledger.get("root")?.status).toBe("running")
  expect(ledger.get("root")?.answer).toBe("")
  expect(ledger.get("child")?.status).toBe("running")
})
it("keeps corrupt historical primitive fields in the defect channel", async () => {
  const db = database(),
    ledger = new ConversationStore(db, { model: "test", thinking: "off" }),
    service = makeConversations(ledger)
  ledger.admit({ operationId: "root", text: "Request" })
  db.run("UPDATE chat_turns SET status='unknown' WHERE id='root'")
  const exit = await Effect.runPromise(Effect.exit(service.get("root")))
  expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
})
