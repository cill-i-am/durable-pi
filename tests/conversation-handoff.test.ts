import { Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { clocklessHandoff } from "../src/conversations/adapters/handoff"
import { ConversationLatency } from "../src/conversations/latency"

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
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
