import { describe, expect, it } from "vitest"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import {
  ConversationConflict,
  ConversationFull,
} from "../src/conversations/turns"
import { database } from "./database"

const defaults = { model: "test-model", thinking: "medium" as const }
const input = (text = "hello", mode: "followUp" | "steer" = "followUp") => ({
  operationId: crypto.randomUUID(),
  text,
  mode,
})
describe("durable reply admission", () => {
  it("preserves the legacy table and joins steers while keeping follow-ups fresh", () => {
    const db = database()
    db.run(
      "CREATE TABLE chat_turns (id TEXT PRIMARY KEY,text TEXT NOT NULL,status TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',error TEXT,created_at TEXT NOT NULL,session_id TEXT,prompt TEXT)"
    )
    db.run(
      "INSERT INTO chat_turns(id,text,status,created_at) VALUES ('legacy','existing','done','2026-10-10')"
    )
    const store = new ConversationStore(db, defaults)
    expect(store.recent()[0]?.text).toBe("existing")
    const root = store.admit(input()).turn
    const steer = store.admit(
      input("actually, use the other file", "steer")
    ).turn
    const queued = store.admit(input("next task")).turn
    expect(steer.parent_id).toBe(root.id)
    expect(queued.parent_id).toBeNull()
    expect(store.active()?.id).toBe(root.id)
    expect(store.recent().map((turn) => turn.id)).toEqual([
      "legacy",
      root.id,
      queued.id,
    ])
    expect(new ConversationStore(db, defaults).members(root.id)).toHaveLength(2)
  })
  it("deduplicates retries and rejects operation-key reuse with different semantics", () => {
    const store = new ConversationStore(database(), defaults)
    const command = input()
    expect(store.admit(command).accepted).toBe(true)
    store.setSettings({ model: "another", thinking: "low" })
    expect(store.admit(command).accepted).toBe(false)
    expect(() => store.admit({ ...command, mode: "steer" })).toThrow(
      ConversationConflict
    )
    expect(() => store.admit({ ...command, text: "different" })).toThrow(
      ConversationConflict
    )
    expect(store.get(command.operationId)?.model).toBe("test-model")
  })
  it("does not lose a steer admitted while completion was awaiting Pi", () => {
    const store = new ConversationStore(database(), defaults)
    const root = store.admit(input()).turn
    store.prepare(root.id)
    store.submitted(root.id, "session")
    const completing = store.get(root.id)!
    const steer = store.admit(input("one more detail", "steer")).turn
    expect(
      store.finish(
        completing,
        [{ id: root.id, delivery: "answered" }],
        "answer",
        null
      )
    ).toBe(false)
    store.submitted(steer.id, "session")
    store.consumed(steer.id)
    const current = store.get(root.id)!
    expect(
      store.finish(
        current,
        [
          { id: root.id, delivery: "answered" },
          { id: steer.id, delivery: "answered" },
        ],
        "revised answer",
        null
      )
    ).toBe(true)
    const late = store.admit(input("arrives after close", "steer")).turn
    expect(late.parent_id).toBeNull()
  })
  it("keeps stop durable across restart and does not let submission overwrite it", () => {
    const db = database()
    const store = new ConversationStore(db, defaults)
    const root = store.admit(input()).turn
    const child = store.admit(input("additional input", "steer")).turn
    store.requestStop(child.id)
    store.submitted(root.id, "session")
    const restored = new ConversationStore(db, defaults)
    expect(restored.active()?.status).toBe("stopping")
    expect(
      restored.finish(
        restored.get(root.id)!,
        [
          { id: root.id, delivery: "unanswered" },
          { id: child.id, delivery: "unanswered" },
        ],
        "partial",
        null
      )
    ).toBe(true)
    expect(restored.get(root.id)?.status).toBe("cancelled")
    expect(restored.get(child.id)?.delivery).toBe("unanswered")
    expect(restored.active()).toBeUndefined()
  })
  it("caps pending work and rejects retrying a still-running reply", () => {
    const store = new ConversationStore(database(), defaults)
    const root = store.admit(input()).turn
    expect(() => store.admit({ ...input(), retryOf: root.id })).toThrow(
      ConversationConflict
    )
    for (let i = 0; i < 9; i++) store.admit(input(String(i), "steer"))
    expect(() => store.admit(input())).toThrow(ConversationFull)
  })
})
