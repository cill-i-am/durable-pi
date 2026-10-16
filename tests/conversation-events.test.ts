import type { AgentEventStream } from "@earendil-works/pi-durable"
import { Cause, Effect, Exit, Layer, Logger, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  ConversationStreamError,
  conversationEvents,
} from "../src/conversations/adapters/events"
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

function deferred<TValue>() {
  let resolve!: (value: TValue) => void
  const promise = new Promise<TValue>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function watch(
  stop = vi.fn(async () => ({ reason: "stopped" as const }))
): AgentEventStream {
  return {
    snapshot: {
      type: "snapshot",
      nestedTools: [],
      entries: [],
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    },
    start: vi.fn(),
    stop,
    closed: Promise.resolve({ reason: "stopped" }),
  }
}

function fixture() {
  let state = initial
  let listener = () => {}
  const unsubscribe = vi.fn()
  const controller = new AbortController()
  const response = conversationEvents(
    {
      snapshot: () => Effect.sync(() => state),
      activeSession: () => Effect.succeed(undefined),
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
  it("joins late acquisition and delayed closure before reader cancellation completes", async () => {
    const started = deferred<void>(),
      acquired = deferred<AgentEventStream>(),
      stopping = deferred<void>(),
      released = deferred<void>()
    const stream = watch(
      vi.fn(async () => {
        stopping.resolve()
        await released.promise
        return { reason: "stopped" as const }
      })
    )
    const snapshot = vi.fn(() => Effect.succeed(initial)),
      unsubscribe = vi.fn()
    const response = conversationEvents(
      {
        snapshot,
        activeSession: () => Effect.succeed("one"),
        watch: async () => {
          started.resolve()
          return acquired.promise
        },
        subscribe: () => unsubscribe,
      },
      new AbortController().signal
    )
    const reader = response.body!.getReader()
    await started.promise
    let ended = false
    const closing = reader.cancel().then(() => {
      ended = true
    })
    expect(ended).toBe(false)
    acquired.resolve(stream)
    await stopping.promise
    expect(ended).toBe(false)
    expect(stream.start).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    released.resolve()
    await closing
    expect(stream.stop).toHaveBeenCalledOnce()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
  it("waits for native closure before finishing an aborted HTTP body", async () => {
    const entered = deferred<void>(),
      released = deferred<void>()
    const stream = watch(
      vi.fn(async () => {
        entered.resolve()
        await released.promise
        return { reason: "stopped" as const }
      })
    )
    const controller = new AbortController()
    const response = conversationEvents(
      {
        snapshot: () => Effect.succeed(initial),
        activeSession: () => Effect.succeed("one"),
        watch: async () => stream,
        subscribe: () => () => {},
      },
      controller.signal
    )
    const reader = response.body!.getReader()
    await frame(reader)
    controller.abort()
    await entered.promise
    let ended = false
    const next = reader.read().then((value) => {
      ended = true
      return value
    })
    expect(ended).toBe(false)
    released.resolve()
    expect((await next).done).toBe(true)
    expect(stream.stop).toHaveBeenCalledOnce()
  })
  it("closes the old session watcher before acquiring its replacement", async () => {
    vi.useFakeTimers()
    const stopping = deferred<void>(),
      released = deferred<void>(),
      replaced = deferred<void>()
    const first = watch(
        vi.fn(async () => {
          stopping.resolve()
          await released.promise
          return { reason: "stopped" as const }
        })
      ),
      second = watch()
    let session = "one",
      state = initial,
      notify = () => {}
    const attach = vi.fn(async (id: string) => {
      if (id === "one") return first
      replaced.resolve()
      return second
    })
    const response = conversationEvents(
      {
        snapshot: () => Effect.sync(() => state),
        activeSession: () => Effect.sync(() => session),
        watch: attach,
        subscribe: (listener) => {
          notify = listener
          return () => {}
        },
      },
      new AbortController().signal
    )
    const reader = response.body!.getReader()
    await frame(reader)
    session = "two"
    state = { ...initial, connected: false }
    notify()
    await vi.advanceTimersByTimeAsync(80)
    await stopping.promise
    expect(attach).toHaveBeenCalledTimes(1)
    released.resolve()
    await replaced.promise
    expect(await frame(reader)).toMatchObject({
      type: "update",
      meta: { connected: false },
    })
    await reader.cancel()
    expect(first.stop).toHaveBeenCalledOnce()
    expect(second.stop).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
  it("reports cleanup defects without exposing native error payloads", async () => {
    const logs: string[] = []
    const stream = watch(
      vi.fn(async () => {
        throw new Error("private native payload")
      })
    )
    const response = conversationEvents(
      {
        snapshot: () => Effect.succeed(initial),
        activeSession: () => Effect.succeed("one"),
        watch: async () => stream,
        subscribe: () => () => {},
      },
      new AbortController().signal,
      false,
      (program, options) =>
        Effect.runPromiseExit(
          program.pipe(
            Effect.provide(
              Logger.layer([
                Logger.make((entry) => {
                  logs.push(String(entry.message))
                }),
              ])
            )
          ),
          options
        )
    )
    const reader = response.body!.getReader()
    await frame(reader)
    await expect(reader.cancel()).rejects.toThrow(
      "Conversation stream cleanup failed."
    )
    expect(logs).toEqual(["Conversation.streamFailed"])
  })
  it("keeps the body in the actor scope and joins native closure during runtime disposal", async () => {
    const stopping = deferred<void>(),
      released = deferred<void>()
    const stream = watch(
      vi.fn(async () => {
        stopping.resolve()
        await released.promise
        return { reason: "stopped" as const }
      })
    )
    const runtime = ManagedRuntime.make(Layer.empty)
    const response = conversationEvents(
      {
        snapshot: () => Effect.succeed(initial),
        activeSession: () => Effect.succeed("one"),
        watch: async () => stream,
        subscribe: () => () => {},
      },
      new AbortController().signal,
      false,
      (program, options) => runtime.runPromiseExit(program, options)
    )
    const reader = response.body!.getReader()
    await frame(reader)
    let disposed = false
    const closing = runtime.dispose().then(() => {
      disposed = true
    })
    await stopping.promise
    expect(disposed).toBe(false)
    released.resolve()
    await closing
    expect((await reader.read()).done).toBe(true)
    expect(stream.stop).toHaveBeenCalledOnce()
  })
  it("starts with durable state and publishes turn deltas and removals", async () => {
    vi.useFakeTimers()
    const f = fixture()
    const first = await frame(f.reader)
    expect(first).toEqual({ type: "snapshot", state: initial })
    f.change({ ...initial, turns: [turn] })
    await vi.advanceTimersByTimeAsync(80)
    const update = await frame(f.reader)
    expect(update).toEqual({ type: "update", turns: [turn], ids: [turn.id] })
    f.change({ ...initial, turns: [], connected: false })
    await vi.advanceTimersByTimeAsync(80)
    expect(await frame(f.reader)).toMatchObject({
      type: "update",
      turns: [],
      ids: [],
      meta: { connected: false },
    })
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
    while (!(await second.reader.read()).done) {}
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
        snapshot: () => Effect.succeed(initial),
        activeSession: () => Effect.succeed("one"),
        watch: () => pending,
        subscribe: () => () => {},
      },
      controller.signal
    )
    const reader = response.body!.getReader()
    await Promise.resolve()
    controller.abort()
    attach({
      snapshot: {
        type: "snapshot",
        nestedTools: [],
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

it.each(["acquire", "stop"])(
  "retains a native compound watcher %s Cause",
  async (mode) => {
    const defect = new Error("private watcher defect")
    const cause = Cause.fromReasons([
      Cause.makeFailReason(
        new ConversationStreamError({ operation: "probe", cause: "private" })
      ),
      Cause.makeDieReason(defect),
      Cause.makeInterruptReason(),
    ])
    const completed = deferred<void>()
    let failed: Cause.Cause<unknown> | undefined
    const stream = watch(
      vi.fn(async () => {
        throw cause
      })
    )
    const response = conversationEvents(
      {
        snapshot: () => Effect.succeed(initial),
        activeSession: () => Effect.succeed("one"),
        watch: async () => {
          if (mode === "acquire") throw cause
          return stream
        },
        subscribe: () => () => {},
      },
      new AbortController().signal,
      false,
      (program, options) => {
        const pending = Effect.runPromiseExit(
          program.pipe(Effect.provide(Logger.layer([]))),
          options
        )
        void pending.then((exit) => {
          if (Exit.isFailure(exit)) failed = exit.cause
          completed.resolve()
        })
        return pending
      }
    )
    const reader = response.body!.getReader()
    if (mode === "stop") {
      await frame(reader)
      await expect(reader.cancel()).rejects.toThrow(
        "Conversation stream cleanup failed."
      )
    } else expect((await reader.read()).done).toBe(true)
    await completed.promise
    expect(failed && Cause.hasInterrupts(failed)).toBe(true)
    expect(failed?.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  }
)
