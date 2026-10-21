import { Deferred, Effect, Fiber } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { makeFirstTextLatency } from "../src/conversations/adapters/latency"
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
    const observer = Effect.runSync(makeFirstTextLatency)
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
      receivedAt: expect.any(Number),
      outputAt: expect.any(Number),
    })
    expect(Effect.runSync(observer.output)).toBeUndefined()
  }
)

it("ignores malformed and oversized diagnostic lines without failing delivery", () => {
  const observer = Effect.runSync(makeFirstTextLatency)
  for (const line of [
    'data: {"type":"CUSTOM","name":"durable-pi.first-text",broken\n',
    marker.replace('"turn"', JSON.stringify("x".repeat(3000))),
    marker.replace('"publishedAt":100', '"publishedAt":"private"'),
  ])
    Effect.runSync(observer.receive(new TextEncoder().encode(line)))
  expect(Effect.runSync(observer.output)).toBeUndefined()
})

it.each([undefined, 4096, 16384] as const)(
  "publishes a correlated marker with bounded diagnostic padding (%s)",
  async (paddingBytes) => {
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
        paddingBytes: paddingBytes ?? 4096,
        ...(paddingBytes ? { confirmation: Effect.void } : {}),
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
    expect(response.headers.has("x-durable-pi-stream-opened-at")).toBe(
      Boolean(paddingBytes)
    )
    await reader.read()
    Effect.runSync(latency.provider("turn", "attempt", "session"))
    state = { ...state, turns: [{ ...turn, answer: "Hello" }] }
    notify()
    const text = new TextDecoder().decode((await reader.read()).value)
    expect(text).toContain('"name":"durable-pi.first-text"')
    expect(text).toContain('"type":"TEXT_MESSAGE_START"')
    expect(text).toContain('"turnId":"turn"')
    if (paddingBytes) {
      expect(text.indexOf("data: ")).toBe(paddingBytes)
      expect(text.slice(0, paddingBytes)).toBe(
        `:${" ".repeat(paddingBytes - 3)}\n\n`
      )
      const observer = Effect.runSync(makeFirstTextLatency)
      Effect.runSync(observer.receive(new TextEncoder().encode(text)))
      expect(Effect.runSync(observer.output)?.attemptId).toBe("attempt")
    } else expect(text.startsWith("data: ")).toBe(true)
    await reader.cancel()
  }
)

it("times storage confirmation only for a new traced answer and joins it once", () => {
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  const latency = new ConversationLatency()
  const sync = vi.fn(() => vi.setSystemTime(1600))
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  vi.setSystemTime(1100)
  Effect.runSync(latency.confirm(["historical"], Effect.sync(sync)))
  expect(sync).not.toHaveBeenCalled()
  Effect.runSync(latency.confirm(["turn"], Effect.sync(sync)))
  Effect.runSync(latency.confirm(["turn"], Effect.sync(sync)))
  expect(sync).toHaveBeenCalledTimes(1)
  expect(Effect.runSync(latency.publication("turn", 1080, 1100))).toMatchObject(
    {
      providerAt: 1000,
      snapshotReadyAt: 1100,
      storageSyncStartedAt: 1100,
      storageSyncReadyAt: 1600,
      publishedAt: 1600,
    }
  )
})

it("joins a pending confirmation before either stream publishes its marker", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const latency = new ConversationLatency()
      const started = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      let calls = 0
      const sync = Effect.gen(function* () {
        calls++
        yield* Deferred.succeed(started, undefined)
        yield* Deferred.await(release)
      })
      yield* latency.provider("turn", "attempt", "session")
      const stream = latency
        .confirm(["turn"], sync)
        .pipe(Effect.andThen(latency.publication("turn", 0, 0)))
      const first = yield* Effect.forkChild(stream)
      yield* Deferred.await(started)
      const second = yield* Effect.forkChild(stream)
      yield* Effect.yieldNow
      expect(second.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(release, undefined)
      const traces = yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(calls).toBe(1)
      for (const trace of traces)
        expect(trace?.storageSyncReadyAt).toEqual(expect.any(Number))
    })
  )
})

it("observes a split marker without changing streamed bytes or retaining private fields", async () => {
  const { observeFirstText } =
    await import("../src/conversations/adapters/latency")
  const observed: unknown[] = []
  const bytes = new TextEncoder().encode(
    `data: ${"private🙂".repeat(1000)}\n\n${marker}`
  )
  let offset = 0
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === bytes.length) return controller.close()
      const end = Math.min(offset + 7, bytes.length)
      controller.enqueue(bytes.slice(offset, end))
      offset = end
    },
  })
  const response = Effect.runSync(
    observeFirstText(
      new Response(source, {
        headers: { "content-type": "text/event-stream", "x-preserved": "yes" },
      }),
      (trace) => {
        observed.push(trace)
        throw new Error("diagnostic only")
      }
    )
  )
  expect(response.headers.get("x-preserved")).toBe("yes")
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(observed).toEqual([
    {
      turnId: "turn",
      attemptId: "attempt",
      publishedAt: 100,
      receivedAt: expect.any(Number),
      outputAt: expect.any(Number),
      readStartedAt: expect.any(Number),
    },
  ])
  expect(source.locked).toBe(false)
})

it("joins upstream cancellation while a diagnostic read is pending", async () => {
  const { observeFirstText } =
    await import("../src/conversations/adapters/latency")
  let release!: () => void
  const cancelled = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancel = vi.fn(() => cancelled)
  const source = new ReadableStream<Uint8Array>({ cancel })
  const response = Effect.runSync(
    observeFirstText(
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
      () => {}
    )
  )
  const reader = response.body!.getReader()
  const pending = reader.read()
  const reason = new Error("client disconnected")
  let settled = false
  const stopping = reader.cancel(reason).then(() => {
    settled = true
  })
  await Promise.resolve()
  expect(cancel).toHaveBeenCalledWith(reason)
  expect(settled).toBe(false)
  release()
  await stopping
  expect(await pending).toEqual({ value: undefined, done: true })
  expect(source.locked).toBe(false)
})

it("propagates upstream stream failure and releases its reader", async () => {
  const { observeFirstText } =
    await import("../src/conversations/adapters/latency")
  const error = new Error("upstream failed")
  const source = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.error(error)
    },
  })
  const response = Effect.runSync(
    observeFirstText(
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
      () => {}
    )
  )
  await expect(response.text()).rejects.toBe(error)
  expect(source.locked).toBe(false)
})

it("records the outstanding gateway read before a delayed first-text chunk", async () => {
  const { observeFirstText } =
    await import("../src/conversations/adapters/latency")
  vi.useFakeTimers()
  vi.setSystemTime(1000)
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const source = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
  })
  const observed: unknown[] = []
  const response = Effect.runSync(
    observeFirstText(
      new Response(source, {
        headers: { "content-type": "text/event-stream" },
      }),
      (trace) => {
        observed.push(trace)
      }
    )
  )
  const reading = response.text()
  await Promise.resolve()
  await Promise.resolve()
  vi.setSystemTime(2000)
  controller.enqueue(
    new TextEncoder().encode(
      marker.replace(
        '"publishedAt":100',
        '"publishedAt":100,"streamId":"diagnostic-stream"'
      )
    )
  )
  controller.close()
  await reading
  expect(observed).toEqual([
    {
      turnId: "turn",
      attemptId: "attempt",
      publishedAt: 100,
      streamId: "diagnostic-stream",
      readStartedAt: 1000,
      receivedAt: 2000,
      outputAt: 2000,
    },
  ])
})

it("publishes first text while a post-enqueue durability probe is pending and joins cancellation", async () => {
  const { conversationEvents } =
    await import("../src/conversations/adapters/events")
  const latency = new ConversationLatency()
  const turn = {
    id: "turn",
    text: "hi",
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
  let calls = 0
  let started!: () => void
  let release!: () => void
  const probing = new Promise<void>((resolve) => {
    started = resolve
  })
  const confirmed = new Promise<void>((resolve) => {
    release = resolve
  })
  const response = conversationEvents(
    {
      latency,
      confirmation: Effect.uninterruptible(
        Effect.promise(() => {
          if (++calls === 1) return Promise.resolve()
          started()
          return confirmed
        })
      ),
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
  Effect.runSync(latency.provider("turn", "attempt", "session"))
  state = { ...state, turns: [{ ...turn, answer: "Hello" }] }
  notify()
  const text = new TextDecoder().decode((await reader.read()).value)
  expect(text).toContain('"name":"durable-pi.first-text"')
  expect(text).toContain('"streamId":')
  await probing
  let stopped = false
  const stopping = reader.cancel().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  release()
  await stopping
  expect(stopped).toBe(true)
})
