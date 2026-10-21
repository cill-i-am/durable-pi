import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  ConversationCheckpoint,
  conversationEvents,
} from "../src/conversations/adapters/events"
import { ConversationLatency } from "../src/conversations/latency"

afterEach(() => vi.useRealTimers())

it("delivers the entire first-text batch when the consumer has paused before its initial cursor", async () => {
  vi.useFakeTimers()
  const turn = {
    id: "turn",
    text: "question",
    answer: "",
    status: "running" as const,
    error: null,
    created_at: "2026-10-21",
  }
  let state = {
    turns: [turn],
    model: "test",
    connected: true,
    memory: { messages: 0, summaries: 0, ready: true, notes: [] },
  }
  let notify = () => {}
  const unsubscribe = vi.fn()
  const latency = new ConversationLatency()
  const response = conversationEvents(
    {
      latency,
      snapshot: () => Effect.sync(() => state),
      activeSession: () => Effect.succeed(undefined),
      watch: async () => {
        throw new Error("unused")
      },
      subscribe: (listener) => {
        notify = listener
        return unsubscribe
      },
    },
    new AbortController().signal,
    true,
    Effect.runPromiseExit,
    { checkpoint: new ConversationCheckpoint(), after: null }
  )
  await vi.advanceTimersByTimeAsync(0)
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  state = { ...state, turns: [{ ...turn, answer: "First token" }] }
  notify()
  await vi.advanceTimersByTimeAsync(0)
  const reader = response.body!.getReader()
  let received = ""
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      received += new TextDecoder().decode(chunk.value)
      if (received.includes('"type":"TEXT_MESSAGE_CONTENT"')) break
    }
    expect(received).toContain('"type":"TEXT_MESSAGE_CONTENT"')
    expect(received).toContain('"delta":"First token"')
  } finally {
    await reader.cancel()
  }
  expect(unsubscribe).toHaveBeenCalledOnce()
})

async function pausedConsumer() {
  vi.useFakeTimers()
  let state = {
    turns: [],
    model: "initial",
    connected: true,
    memory: { messages: 0, summaries: 0, ready: true, notes: [] },
  }
  let notify = () => {}
  const unsubscribe = vi.fn()
  const response = conversationEvents(
    {
      snapshot: () => Effect.sync(() => state),
      activeSession: () => Effect.succeed(undefined),
      watch: async () => {
        throw new Error("unused")
      },
      subscribe: (listener) => {
        notify = listener
        return unsubscribe
      },
    },
    new AbortController().signal,
    true,
    Effect.runPromiseExit,
    { checkpoint: new ConversationCheckpoint(), after: null }
  )
  await vi.advanceTimersByTimeAsync(0)
  for (let i = 1; i <= 4; i++) {
    state = { ...state, model: i === 4 ? "latest" : `model-${i}` }
    notify()
    await vi.advanceTimersByTimeAsync(80)
  }
  return { reader: response.body!.getReader(), unsubscribe }
}

it("waits for reader demand and skips redundant heartbeats while its bounded queue is full", async () => {
  const f = await pausedConsumer()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(f.unsubscribe).not.toHaveBeenCalled()
  let received = ""
  try {
    for (;;) {
      const next = await f.reader.read()
      if (next.done) break
      received += new TextDecoder().decode(next.value)
      if (received.includes('"model":"latest"')) break
    }
    expect(received).toContain('"model":"latest"')
    expect(received.match(/durable-pi.cursor/g)).toHaveLength(5)
  } finally {
    await f.reader.cancel()
  }
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})

it("joins cancellation while waiting for capacity without requiring another read", async () => {
  const f = await pausedConsumer()
  await f.reader.cancel()
  expect(f.unsubscribe).toHaveBeenCalledOnce()
})
