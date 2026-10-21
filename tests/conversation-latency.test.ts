import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { makeEventStreamLatency } from "../src/auth/adapters/event-stream-latency"
import { ConversationLatency } from "../src/conversations/latency"

afterEach(() => vi.useRealTimers())

it("correlates one provider milestone per turn and bounds actor diagnostics", () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const latency = new ConversationLatency()
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  vi.setSystemTime(1100)
  Effect.runSync(latency.native("other"))
  Effect.runSync(latency.native("session"))
  vi.setSystemTime(1300)
  Effect.runSync(latency.provider("turn", "second-attempt", "session"))
  expect(Effect.runSync(latency.publication("turn", 1150, 1250))).toEqual({
    turnId: "turn",
    attemptId: "attempt",
    sessionId: "session",
    providerAt: 1000,
    nativeObservedAt: 1100,
    snapshotStartedAt: 1150,
    snapshotReadyAt: 1250,
    publishedAt: 1300,
  })
  for (let index = 0; index < 32; index++)
    Effect.runSync(latency.provider(`turn-${index}`, "attempt", "session"))
  expect(Effect.runSync(latency.publication("turn", 0, 0))).toBeUndefined()
})

const marker = `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.first-text", value: { turnId: "turn", attemptId: "attempt", publishedAt: 100, sessionId: "never-logged", providerAt: 50 } })}\n\n`
it.each([1, 7, 4096, 300000])(
  "observes a marker across %i-byte chunks after a large private frame",
  (size) => {
    const observer = Effect.runSync(makeEventStreamLatency)
    const bytes = new TextEncoder().encode(
      `data: ${"private".repeat(40000)}\n\n${marker}`
    )
    for (let offset = 0; offset < bytes.length; offset += size)
      Effect.runSync(observer.receive(bytes.slice(offset, offset + size)))
    const result = Effect.runSync(observer.output)
    expect(result).toEqual({
      turnId: "turn",
      attemptId: "attempt",
      publishedAt: 100,
      proxyReceivedAt: expect.any(Number),
      proxyOutputAt: expect.any(Number),
    })
    expect(Effect.runSync(observer.output)).toBeUndefined()
  }
)

it("ignores malformed and oversized diagnostic lines without failing delivery", () => {
  const observer = Effect.runSync(makeEventStreamLatency)
  for (const line of [
    'data: {"type":"CUSTOM","name":"durable-pi.first-text",broken\n',
    marker.replace('"turn"', JSON.stringify("x".repeat(3000))),
    marker.replace('"publishedAt":100', '"publishedAt":"private"'),
  ])
    Effect.runSync(observer.receive(new TextEncoder().encode(line)))
  expect(Effect.runSync(observer.output)).toBeUndefined()
})

it("publishes a correlated marker alongside first text without an extra queue slot", async () => {
  const { conversationEvents } =
    await import("../src/conversations/adapters/events")
  const latency = new ConversationLatency()
  const turn = {
    id: "turn",
    text: "hello",
    answer: "",
    status: "running" as const,
    error: null,
    created_at: "2026-10-21T00:00:00Z",
  }
  let state = {
    turns: [turn],
    model: "test",
    connected: true,
    memory: { messages: 0, summaries: 0, ready: true, notes: [] },
  }
  let notify = () => {}
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
        return () => {}
      },
    },
    new AbortController().signal,
    true
  )
  const reader = response.body!.getReader()
  await reader.read()
  await reader.read()
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  state = { ...state, turns: [{ ...turn, answer: "Hello" }] }
  notify()
  const text = new TextDecoder().decode((await reader.read()).value)
  expect(text).toContain('"name":"durable-pi.first-text"')
  expect(text).toContain('"type":"TEXT_MESSAGE_START"')
  expect(text).toContain('"turnId":"turn"')
  await reader.cancel()
})
