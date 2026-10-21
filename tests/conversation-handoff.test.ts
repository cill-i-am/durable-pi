import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { conversationEvents } from "../src/conversations/adapters/events"
import { clocklessHandoff } from "../src/conversations/adapters/handoff"
import { conversationOutput } from "../src/conversations/adapters/output"
import { ConversationLatency } from "../src/conversations/latency"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([false, true])(
  "keeps causal markers opt-in and releases the observer on joined cancellation (%s)",
  async (milestones) => {
    const latency = new ConversationLatency()
    const turn = {
      id: "turn",
      text: "private question",
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
    const response = conversationEvents(
      {
        latency,
        milestones,
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
    let received = ""
    Effect.runSync(latency.provider("turn", "attempt", "session"))
    if (milestones) {
      const text = new TextDecoder().decode((await reader.read()).value)
      expect(JSON.parse(text.slice(6))).toEqual({
        type: "CUSTOM",
        name: "durable-pi.handoff",
        value: { stage: "provider", turnId: "turn", attemptId: "attempt" },
      })
      expect(text).not.toContain("private")
      received += text
    }
    Effect.runSync(latency.native("session"))
    if (milestones)
      received += new TextDecoder().decode((await reader.read()).value)
    state = { ...state, turns: [{ ...turn, answer: "First text" }] }
    notify()
    received += new TextDecoder().decode((await reader.read()).value)
    expect(received).toContain('"delta":"First text"')
    expect(received.includes("durable-pi.handoff")).toBe(milestones)
    await reader.cancel()
    const one = latency.observe(() => {})
    const two = latency.observe(() => {})
    expect(one && two).toBeTruthy()
    one?.()
    two?.()
  }
)

it("never lets a diagnostic steal a reserved publication slot", () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  new ReadableStream<Uint8Array>(
    {
      start: (value) => {
        controller = value
      },
    },
    { highWaterMark: 1 }
  )
  const queue = conversationOutput(controller, () => false)
  Effect.runSync(queue.reserve)
  expect(queue.diagnostic("probe")).toBe(false)
  expect(queue.enqueue("complete batch")).toBe(true)
  queue.release()
  expect(queue.diagnostic("full queue")).toBe(false)
})

it("emits causal IDs once, bounds observer count and removes failed observers", () => {
  const latency = new ConversationLatency()
  const events: unknown[] = []
  const release = latency.observe((event) => events.push(event))!
  latency.observe(() => {
    throw new Error("diagnostic disconnected")
  })
  expect(latency.observe(() => {})).toBeUndefined()
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  Effect.runSync(latency.provider("turn", "retry", "session"))
  Effect.runSync(latency.native("session"))
  Effect.runSync(latency.native("session"))
  Effect.runSync(latency.enqueued("turn", "attempt", "stream"))
  expect(events).toEqual([
    { stage: "provider", turnId: "turn", attemptId: "attempt" },
    { stage: "native", turnId: "turn", attemptId: "attempt" },
    {
      stage: "enqueued",
      turnId: "turn",
      attemptId: "attempt",
      streamId: "stream",
    },
  ])
  release()
  const one = latency.observe(() => {})
  const two = latency.observe(() => {})
  expect(one && two).toBeTruthy()
  one?.()
  two?.()
})

it("expires the observer scope at 60 seconds while a connected consumer reads", async () => {
  vi.useFakeTimers()
  // Ownership/deadline proof only. The workerd fixture separately verifies
  // actual IdentityTransformStream cancellation and stalled native writes.
  vi.stubGlobal("IdentityTransformStream", TransformStream)
  const latency = new ConversationLatency()
  const owned: Promise<void>[] = []
  const response = await Effect.runPromise(
    clocklessHandoff(
      latency,
      Effect.void,
      new AbortController().signal,
      Effect.runPromiseExit,
      (task) => {
        owned.push(task)
      }
    )
  )
  const consume = (async () => {
    const reader = response.body!.getReader()
    try {
      while (!(await reader.read()).done) {
        /* Drain the diagnostic. */
      }
    } catch {
      /* Expiry aborts the volatile native diagnostic. */
    } finally {
      reader.releaseLock()
    }
  })()
  await vi.advanceTimersByTimeAsync(59_999)
  // The control is included in the same 60s authentication window.
  await vi.advanceTimersByTimeAsync(1)
  await Promise.all([...owned, consume])
  const one = latency.observe(() => {})
  const two = latency.observe(() => {})
  expect(one && two).toBeTruthy()
  one?.()
  two?.()
})

it("joins cleanup if registering the native task owner fails", async () => {
  vi.stubGlobal("IdentityTransformStream", TransformStream)
  const latency = new ConversationLatency()
  const failure = new Error("owner unavailable")
  const exit = await Effect.runPromiseExit(
    clocklessHandoff(
      latency,
      Effect.void,
      new AbortController().signal,
      Effect.runPromiseExit,
      () => {
        throw failure
      }
    )
  )
  expect(exit._tag).toBe("Failure")
  const one = latency.observe(() => {})
  const two = latency.observe(() => {})
  expect(one && two).toBeTruthy()
  one?.()
  two?.()
})
