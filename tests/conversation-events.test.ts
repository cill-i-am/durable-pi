import type { AgentEventStream } from "@earendil-works/pi-durable"
import { afterEach, describe, expect, it, vi } from "vitest"
import { conversationEvents } from "../src/conversations/adapters/events"
import { applyConversationFrame } from "../src/features/conversation/live-state"
import type {
  ChatState,
  ConversationFrame,
} from "../src/conversations/contracts"

const initial: ChatState = {
  turns: [],
  model: "test",
  connected: true,
  memory: { messages: 0, summaries: 0, ready: true, notes: [] },
}
const turn = {
  id: "one",
  text: "hello",
  status: "running" as const,
  answer: "",
  error: null,
  created_at: "2026-10-10T00:00:00Z",
}
afterEach(() => vi.useRealTimers())

function fixture() {
  let state = initial
  let listener = () => {}
  const unsubscribe = vi.fn()
  const controller = new AbortController()
  const response = conversationEvents(
    {
      snapshot: async () => state,
      activeSession: () => undefined,
      watch: async () => {
        throw new Error("unexpected watch")
      },
      subscribe: (next) => {
        listener = next
        return unsubscribe
      },
    },
    controller.signal
  )
  const reader = response.body!.getReader()
  return {
    response,
    reader,
    controller,
    unsubscribe,
    change: (next: ChatState) => {
      state = next
      listener()
    },
  }
}
async function frame(
  reader: ReadableStreamDefaultReader<Uint8Array>
): Promise<ConversationFrame> {
  const next = await reader.read()
  expect(next.done).toBe(false)
  return JSON.parse(new TextDecoder().decode(next.value).replace(/^data: /, ""))
}

describe("conversation stream", () => {
  it("starts with durable state and publishes turn deltas and removals", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = await frame(f.reader)
    expect(first).toEqual({ type: "snapshot", state: initial })
    f.change({ ...initial, turns: [turn] })
    await vi.advanceTimersByTimeAsync(80)
    const update = await frame(f.reader)
    expect(update).toEqual({ type: "update", turns: [turn], ids: [turn.id] })
    const added = applyConversationFrame(initial, update)!
    expect(added.turns).toEqual([turn])
    f.change({ ...initial, turns: [], connected: false })
    await vi.advanceTimersByTimeAsync(80)
    const removed = applyConversationFrame(added, await frame(f.reader))!
    expect(removed.turns).toEqual([])
    expect(removed.connected).toBe(false)
    await f.reader.cancel()
    expect(f.unsubscribe).toHaveBeenCalledOnce()
  })
  it("stops on client abort and periodically reconnects to reauthorize", async () => {
    vi.useFakeTimers()
    const f = fixture()
    await frame(f.reader)
    f.controller.abort()
    expect((await f.reader.read()).done).toBe(true)
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    const second = fixture()
    await frame(second.reader)
    await vi.advanceTimersByTimeAsync(60_000)
    while (!(await second.reader.read()).done) {
      /* drain buffered heartbeat */
    }
    expect(second.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("bounds slow-client buffers and releases subscriptions", async () => {
    vi.useFakeTimers()
    const f = fixture()
    for (let count = 0; count < 8; count++) {
      f.change({ ...initial, memory: { ...initial.memory, messages: count } })
      await vi.advanceTimersByTimeAsync(80)
    }
    expect(f.unsubscribe).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    await f.reader.cancel()
  })
  it("replaces an old connection with a full snapshot without duplicate turns", () => {
    const previous = { ...initial, turns: [turn] }
    const state = {
      ...initial,
      turns: [{ ...turn, status: "done" as const, answer: "finished" }],
    }
    expect(
      applyConversationFrame(previous, { type: "snapshot", state })
    ).toEqual(state)
    expect(
      applyConversationFrame(null, {
        type: "update",
        turns: [turn],
        ids: [turn.id],
      })
    ).toBeNull()
  })
  it("releases a Pi watch that attaches after the HTTP client leaves", async () => {
    let attach!: (watch: AgentEventStream) => void
    const pending = new Promise<AgentEventStream>((resolve) => {
      attach = resolve
    })
    const stop = vi.fn(async () => ({ reason: "stopped" as const }))
    const start = vi.fn()
    const controller = new AbortController()
    const response = conversationEvents(
      {
        snapshot: async () => initial,
        activeSession: () => "one",
        watch: () => pending,
        subscribe: () => () => {},
      },
      controller.signal
    )
    const reader = response.body!.getReader()
    // Let attachment begin, then cancel while its asynchronous acquisition is suspended.
    await Promise.resolve()
    controller.abort()
    attach({
      snapshot: {
        type: "snapshot",
        entries: [],
        tools: [],
        compactions: [],
        inbox: [],
        agent: {},
        usage: { models: {}, tools: {} },
      },
      start,
      stop,
      closed: Promise.resolve({ reason: "stopped" }),
    })
    await Promise.resolve()
    await Promise.resolve()
    expect((await reader.read()).done).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(start).not.toHaveBeenCalled()
  })
})
