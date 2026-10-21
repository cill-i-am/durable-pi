import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  ConversationConflict,
  ConversationFull,
} from "../src/conversations/turns"
import { migrateSqlite } from "../src/storage/migrations"
import { database } from "./database"

const defaults = { model: "test-model", thinking: "medium" as const }
const input = (text = "hello", mode: "followUp" | "steer" = "followUp") => ({
  operationId: crypto.randomUUID(),
  text,
  mode,
})
describe("durable reply admission", () => {
  it("reuses member query shapes while reading fresh bindings and transaction state", () => {
    const db = database()
    const store = new ConversationStore(db, defaults)
    const root = Effect.runSync(store.admit(input("first root"))).turn
    const other = Effect.runSync(store.admit(input("second root"))).turn
    db.run(
      "UPDATE chat_turns SET prompt = ?, skill_context = ? WHERE id = ?",
      "private prompt",
      "private skills",
      root.id
    )
    expect(Effect.runSync(store.members(root.id, false))[0]).toMatchObject({
      id: root.id,
      prompt: null,
      skill_context: "",
    })
    expect(
      Effect.runSync(store.members(other.id, false)).map((row) => row.id)
    ).toEqual([other.id])
    expect(Effect.runSync(store.members(root.id))[0]).toMatchObject({
      id: root.id,
      prompt: "private prompt",
      skill_context: "private skills",
    })
    const steer = Effect.runSync(store.admit(input("new steer", "steer"))).turn
    expect(
      Effect.runSync(store.members(root.id, false)).map((row) => row.id)
    ).toEqual([root.id, steer.id])
    const grouped = Effect.runSync(store.visibleMembers([root.id, other.id]))
    for (const id of [root.id, other.id])
      expect(
        grouped.filter((row) => row.id === id || row.parent_id === id)
      ).toEqual(Effect.runSync(store.members(id, false)))
    expect(
      Effect.runSync(store.visibleMembers([other.id])).map((row) => row.id)
    ).toEqual([other.id])
    expect(Effect.runSync(store.visibleMembers([]))).toEqual([])
    expect(Effect.runSync(store.visibleMembers(["missing"]))).toEqual([])
    const rollback = Effect.runSync(
      Effect.exit(
        db.transaction(() =>
          Effect.gen(function* () {
            yield* store.admit(input("rolled back steer", "steer"))
            expect(yield* store.members(root.id, false)).toHaveLength(3)
            return yield* Effect.fail("rollback")
          })
        )
      )
    )
    expect(rollback._tag).toBe("Failure")
    expect(
      Effect.runSync(store.members(root.id, false)).map((row) => row.id)
    ).toEqual([root.id, steer.id])
  })
  it("reopens saved turns and joins steers while keeping follow-ups fresh", () => {
    const db = database()
    db.run(
      "INSERT INTO chat_turns(id,text,status,created_at) VALUES ('legacy','existing','done','2026-10-10')"
    )
    Effect.runSync(migrateSqlite(db))
    const store = new ConversationStore(db, defaults)
    expect(Effect.runSync(store.recent())[0]?.text).toBe("existing")
    const root = Effect.runSync(store.admit(input())).turn
    const steer = Effect.runSync(
      store.admit(input("actually, use the other file", "steer"))
    ).turn
    const queued = Effect.runSync(store.admit(input("next task"))).turn
    expect(steer.parent_id).toBe(root.id)
    expect(queued.parent_id).toBeNull()
    expect(Effect.runSync(store.active())?.id).toBe(root.id)
    expect(Effect.runSync(store.recent()).map((turn) => turn.id)).toEqual([
      "legacy",
      root.id,
      queued.id,
    ])
    expect(
      Effect.runSync(new ConversationStore(db, defaults).members(root.id))
    ).toHaveLength(2)
  })
  it("deduplicates retries and rejects operation-key reuse with different semantics", () => {
    const store = new ConversationStore(database(), defaults)
    const command = input()
    expect(Effect.runSync(store.admit(command)).accepted).toBe(true)
    Effect.runSync(store.setSettings({ model: "another", thinking: "low" }))
    expect(Effect.runSync(store.admit(command)).accepted).toBe(false)
    expect(() =>
      Effect.runSync(store.admit({ ...command, mode: "steer" }))
    ).toThrow(ConversationConflict)
    expect(() =>
      Effect.runSync(store.admit({ ...command, text: "different" }))
    ).toThrow(ConversationConflict)
    expect(Effect.runSync(store.get(command.operationId))?.model).toBe(
      "test-model"
    )
  })
  it("does not lose a steer admitted while completion was awaiting Pi", () => {
    const store = new ConversationStore(database(), defaults)
    const root = Effect.runSync(store.admit(input())).turn
    Effect.runSync(store.prepare(root.id))
    Effect.runSync(store.submitted(root.id, "session"))
    const completing = Effect.runSync(store.get(root.id))!
    const steer = Effect.runSync(
      store.admit(input("one more detail", "steer"))
    ).turn
    expect(
      Effect.runSync(
        store.finish(
          completing,
          [{ id: root.id, delivery: "answered" }],
          "answer",
          null
        )
      )
    ).toBe(false)
    Effect.runSync(store.submitted(steer.id, "session"))
    Effect.runSync(store.consumed(steer.id))
    const current = Effect.runSync(store.get(root.id))!
    expect(
      Effect.runSync(
        store.finish(
          current,
          [
            { id: root.id, delivery: "answered" },
            { id: steer.id, delivery: "answered" },
          ],
          "revised answer",
          null
        )
      )
    ).toBe(true)
    const late = Effect.runSync(
      store.admit(input("arrives after close", "steer"))
    ).turn
    expect(late.parent_id).toBeNull()
  })
  it("keeps stop durable across restart and does not let submission overwrite it", () => {
    const db = database()
    const store = new ConversationStore(db, defaults)
    const root = Effect.runSync(store.admit(input())).turn
    const child = Effect.runSync(
      store.admit(input("additional input", "steer"))
    ).turn
    Effect.runSync(store.requestStop(child.id))
    Effect.runSync(store.submitted(root.id, "session"))
    const restored = new ConversationStore(db, defaults)
    expect(Effect.runSync(restored.active())?.status).toBe("stopping")
    expect(
      Effect.runSync(
        restored.finish(
          Effect.runSync(restored.get(root.id))!,
          [
            { id: root.id, delivery: "unanswered" },
            { id: child.id, delivery: "unanswered" },
          ],
          "partial",
          null
        )
      )
    ).toBe(true)
    expect(Effect.runSync(restored.get(root.id))?.status).toBe("cancelled")
    expect(Effect.runSync(restored.get(child.id))?.delivery).toBe("unanswered")
    expect(Effect.runSync(restored.active())).toBeUndefined()
  })
  it("caps pending work and rejects retrying a still-running reply", () => {
    const store = new ConversationStore(database(), defaults)
    const root = Effect.runSync(store.admit(input())).turn
    expect(() =>
      Effect.runSync(store.admit({ ...input(), retryOf: root.id }))
    ).toThrow(ConversationConflict)
    for (let i = 0; i < 9; i++)
      Effect.runSync(store.admit(input(String(i), "steer")))
    expect(() => Effect.runSync(store.admit(input()))).toThrow(ConversationFull)
  })
  it("never silently queues steering when stop wins admission, including after restart", () => {
    const db = database()
    const store = new ConversationStore(db, defaults)
    const root = Effect.runSync(store.admit(input())).turn
    const acceptedInput = input("earlier correction", "steer")
    const accepted = Effect.runSync(store.admit(acceptedInput)).turn
    Effect.runSync(store.requestStop(root.id))
    const restored = new ConversationStore(db, defaults)
    expect(Effect.runSync(restored.admit(acceptedInput))).toMatchObject({
      accepted: false,
    })
    const next = input("new correction", "steer")
    expect(() => Effect.runSync(restored.admit(next))).toThrow(
      "This reply is stopping"
    )
    expect(Effect.runSync(restored.get(next.operationId))).toBeUndefined()
    const queued = Effect.runSync(
      restored.admit(input("next task", "followUp"))
    ).turn
    expect(queued.parent_id).toBeNull()
    Effect.runSync(
      restored.finish(
        Effect.runSync(restored.get(root.id))!,
        [
          { id: root.id, delivery: "unanswered" },
          { id: accepted.id, delivery: "unanswered" },
        ],
        "partial",
        null
      )
    )
    expect(Effect.runSync(restored.admit(next)).turn.parent_id).toBe(queued.id)
  })
})
