import { describe, expect, it } from "vitest"
import type { PiHarness } from "agents/harness/pi"
import type {
  EntryRecord,
  SnapshotEvent,
  SubmissionRecord,
} from "@earendil-works/pi-durable"
import {
  readPiReply,
  replySettled,
  placedInputs,
} from "../src/conversations/adapters/pi-reply"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { database } from "./database"

const entry = (id: number): EntryRecord => ({
  id: id as EntryRecord["id"],
  conversationId: 0 as EntryRecord["conversationId"],
  kind: "pi.user",
})
const snapshot = (ids: number[]): SnapshotEvent => ({
  type: "snapshot",
  entries: ids.map(entry),
  tools: [],
  inbox: [],
  compactions: [],
  agent: {},
  usage: { models: {}, tools: {} },
})
const done = {
  id: 1,
  conversationId: 0,
  type: "input",
  status: "done",
  entry: 1,
  answer: 2,
} as SubmissionRecord
function fixture() {
  const store = new ConversationStore(database(), {
    model: "test",
    thinking: "off",
  })
  const root = store.admit({ operationId: "root", text: "hello" }).turn
  store.saveSession(root.id, "session")
  return { store, root: store.get(root.id)! }
}
describe("Pi snapshot and receipt consistency", () => {
  it("reads committed input mappings after capturing the transcript", async () => {
    const { root } = fixture()
    let captured = false
    let stopped = false
    const harness = {
      storage: async () => ({
        submissionByRequest: async () =>
          captured ? done : { ...done, status: "queued", entry: undefined },
      }),
      conversation: async () => ({ id: 0 }),
      session: () => ({
        events: async () => {
          captured = true
          return {
            snapshot: snapshot([1, 2]),
            stop: async () => {
              stopped = true
            },
          }
        },
      }),
    } as unknown as PiHarness
    const reply = await readPiReply(harness, root, [root])
    expect(placedInputs([root], reply.records).get(1)?.id).toBe(root.id)
    expect(stopped).toBe(true)
  })
  it("waits when completion receipts are newer than the captured output", () => {
    const { root } = fixture()
    const records = new Map([[root.id, done]])
    expect(
      replySettled(root, [root], { records, snapshot: snapshot([1]) })
    ).toBe(false)
    expect(
      replySettled(root, [root], { records, snapshot: snapshot([1, 2]) })
    ).toBe(true)
    const active = { ...snapshot([1, 2]), run: { inputs: [] } }
    const unanswered = {
      ...done,
      status: "unanswered",
      reason: "aborted",
      answer: undefined,
    } as SubmissionRecord
    expect(
      replySettled(root, [root], {
        records: new Map([[root.id, unanswered]]),
        snapshot: active,
      })
    ).toBe(false)
  })
  it("settles a stop before initial submission or before a queued steer was submitted", () => {
    const { root, store } = fixture()
    const child = store.admit({
      operationId: "child",
      text: "change it",
      mode: "steer",
    }).turn
    store.requestStop(root.id)
    const stopping = store.get(root.id)!
    expect(
      replySettled(stopping, [stopping, child], {
        snapshot: snapshot([]),
        records: new Map(),
      })
    ).toBe(true)
    expect(
      replySettled(stopping, [stopping, child], {
        snapshot: snapshot([1, 2]),
        records: new Map([[root.id, done]]),
      })
    ).toBe(true)
    expect(
      replySettled(root, [root, child], {
        snapshot: snapshot([1, 2]),
        records: new Map([[root.id, done]]),
      })
    ).toBe(false)
  })
})
