import { EventType, type StreamChunk } from "@tanstack/ai"
import { Cause, Context } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { subscribeConversation } from "../src/features/conversation/connection-owner"
import { ApiError } from "../src/http/client"

const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const frame: StreamChunk = {
  type: "CUSTOM",
  name: "durable-pi.cursor",
  value: cursor,
}
const deferred = <T>() => {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
afterEach(() => vi.useRealTimers())

it("exhausts after exactly five consecutive failures and cleans up every timer", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  let reads = 0
  const notices: StreamChunk[] = []
  const completed = (async () => {
    try {
      for await (const chunk of subscribeConversation(async function* () {
        reads++
        throw new Error("offline")
      }))
        notices.push(chunk)
    } catch (error) {
      return error
    }
  })()
  await vi.advanceTimersByTimeAsync(7499)
  expect(reads).toBe(4)
  await vi.advanceTimersByTimeAsync(1)
  expect(await completed).toEqual(
    new Error("Could not reconnect. Reconnect to try again.")
  )
  expect(reads).toBe(5)
  expect(notices).toHaveLength(4)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(reads).toBe(5)
  expect(vi.getTimerCount()).toBe(0)
})

it("replays the accepted cursor and resets the failure budget after progress", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const reads: (string | null)[] = [],
    delivered: StreamChunk[] = []
  const complete = (async () => {
    try {
      for await (const chunk of subscribeConversation(async function* (after) {
        reads.push(after)
        if (reads.length === 5) yield frame
        throw new Error("interrupted")
      }))
        delivered.push(chunk)
    } catch (cause) {
      return cause
    }
  })()
  for (let step = 0; step < 40; step++) {
    await vi.advanceTimersByTimeAsync(500)
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  expect(reads).toHaveLength(9)
  expect(await complete).toEqual(
    new Error("Could not reconnect. Reconnect to try again.")
  )
  expect(reads).toHaveLength(9)
  expect(reads.slice(0, 5)).toEqual(Array(5).fill(null))
  expect(reads.slice(5)).toEqual(Array(4).fill(cursor))
  expect(delivered).toContainEqual(frame)
  expect(delivered).toContainEqual({
    type: "CUSTOM",
    name: "durable-pi.connection",
    value: "",
  })
})

it.each([401, 403, 404])(
  "does not reconnect after permission rejection %i",
  async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    let reads = 0
    const error = new ApiError(status, "Permission denied")
    const subscription = subscribeConversation(async function* () {
      reads++
      throw new Error("wrapped", { cause: error })
    })
    await expect(subscription.next()).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(reads).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  }
)

it("pre-abort admits no native stream", async () => {
  const controller = new AbortController()
  controller.abort()
  let reads = 0
  const subscription = subscribeConversation(async function* () {
    reads++
    yield frame
  }, controller.signal)
  expect(await subscription.next()).toEqual({ done: true, value: undefined })
  expect(reads).toBe(0)
})

it("abort fences a late frame and joins native teardown before the subscription returns", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  const controller = new AbortController(),
    entered = deferred<void>(),
    cleanup = deferred<void>(),
    release = deferred<void>()
  const remove = vi.spyOn(controller.signal, "removeEventListener")
  let returned = false,
    aborted = false
  const subscription = subscribeConversation(async function* (_after, signal) {
    entered.resolve(undefined)
    try {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true
            resolve()
          },
          { once: true }
        )
      )
      yield frame
    } finally {
      cleanup.resolve(undefined)
      await release.promise
    }
  }, controller.signal)
  const next = subscription.next().then((value) => {
    returned = true
    return value
  })
  await entered.promise
  controller.abort()
  await cleanup.promise
  await vi.advanceTimersByTimeAsync(0)
  expect(aborted).toBe(true)
  expect(returned).toBe(false)
  release.resolve(undefined)
  expect(await next).toEqual({ done: true, value: undefined })
  expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
  expect(vi.getTimerCount()).toBe(0)
})

it.each([false, true])(
  "retains annotated native interruption when abort wins (defect: %s)",
  async (withDefect) => {
    const controller = new AbortController(),
      entered = deferred<void>(),
      release = deferred<void>()
    const defect = new Error("late native teardown")
    const annotations = Context.makeUnsafe(
      new Map([["conversation/native-cleanup", "reader-after-abort"]])
    )
    const interrupted = Cause.makeInterruptReason(90101).annotate(annotations)
    const failure = Cause.fromReasons([
      Cause.makeFailReason("late checked failure").annotate(annotations),
      interrupted,
      ...(withDefect ? [Cause.makeDieReason(defect)] : []),
    ])
    const subscription = subscribeConversation(async function* (
      _after,
      signal
    ) {
      entered.resolve(undefined)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true })
      )
      await release.promise
      yield* [] as StreamChunk[]
      throw failure
    }, controller.signal)
    const next = subscription.next().catch((cause: unknown) => cause)
    await entered.promise
    controller.abort()
    release.resolve(undefined)
    const result = await next
    expect(Cause.isCause(result)).toBe(true)
    if (!Cause.isCause(result)) throw new Error("Expected native cleanup Cause")
    const retainedInterrupt = result.reasons.find(
      (reason) => reason._tag === "Interrupt" && reason.fiberId === 90101
    )
    expect(
      retainedInterrupt?.annotations.get("conversation/native-cleanup")
    ).toBe("reader-after-abort")
    expect(
      result.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          typeof reason.defect === "object" &&
          reason.defect !== null &&
          "_tag" in reason.defect &&
          reason.defect._tag === "Fail" &&
          "annotations" in reason.defect &&
          reason.defect.annotations instanceof Map &&
          reason.defect.annotations.get("conversation/native-cleanup") ===
            "reader-after-abort"
      )
    ).toBe(true)
    if (withDefect)
      expect(
        result.reasons.some(
          (reason) => reason._tag === "Die" && reason.defect === defect
        )
      ).toBe(true)
    expect(
      result.reasons.some(
        (reason) => reason._tag === "Die" && Cause.isCause(reason.defect)
      )
    ).toBe(false)
  }
)

it("keeps a bounded handoff instead of draining a slow consumer's native stream", async () => {
  const controller = new AbortController()
  let reads = 0
  const subscription = subscribeConversation(async function* () {
    for (let index = 0; index < 100; index++) {
      reads++
      yield frame
    }
  }, controller.signal)
  expect((await subscription.next()).value).toMatchObject({
    name: "durable-pi.connection",
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(reads).toBeLessThanOrEqual(2)
  controller.abort()
  await subscription.return(undefined)
})

it("an actor action defect closes the handoff instead of stranding its consumer", async () => {
  const defect = new Error("snapshot observer failed")
  const subscription = subscribeConversation(
    async function* () {
      yield { type: EventType.MESSAGES_SNAPSHOT, messages: [] }
    },
    undefined,
    () => {
      throw defect
    }
  )
  const result = await subscription.next().catch((cause: unknown) => cause)
  expect(
    Cause.isCause(result) &&
      result.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
})
