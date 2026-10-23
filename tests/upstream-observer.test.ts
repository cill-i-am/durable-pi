import { Cause, Deferred, Effect } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import {
  observedUpstreamFetch,
  UpstreamRelay,
} from "../src/inference/adapters/upstream-worker"

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  RpcTarget: class {},
}))

afterEach(() => vi.unstubAllGlobals())

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

import {
  upstreamResponse,
  upstreamTextDetector,
} from "../src/inference/adapters/upstream"

it("detects a nonempty provider text delta across every byte boundary without retaining content", () => {
  const encoded = new TextEncoder().encode(
    'data: {"type":"response.output_text.delta","delta":"private 🌍"}\r\n\r\n'
  )
  for (let split = 0; split <= encoded.length; split++) {
    const detect = Effect.runSync(upstreamTextDetector)
    const first = detect(encoded.slice(0, split))
    const second = detect(encoded.slice(split))
    expect(first || second).toBe(true)
    expect(detect(encoded)).toBe(false)
  }
})
it("ignores reasoning, empty deltas, malformed and oversized lines, and resumes at the next line", () => {
  const detect = Effect.runSync(upstreamTextDetector)
  const encode = (text: string) => new TextEncoder().encode(text)
  expect(
    detect(
      encode('data: {"type":"response.reasoning.delta","delta":"private"}\n')
    )
  ).toBe(false)
  expect(
    detect(encode('data: {"type":"response.output_text.delta","delta":""}\n'))
  ).toBe(false)
  expect(detect(encode("data: invalid\n"))).toBe(false)
  expect(detect(encode("x".repeat(20_000)))).toBe(false)
  expect(
    detect(
      encode('\ndata: {"type":"response.output_text.delta","delta":"yes"}\n')
    )
  ).toBe(true)
})
it("bounds upstream read ahead and joins source cancellation when the actor never reads", async () => {
  let pulls = 0
  let cancelled = false
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++
        controller.enqueue(new Uint8Array(16_384))
      },
      cancel() {
        cancelled = true
      },
    })
  )
  const ready = Effect.runSync(Deferred.make<Response>())
  const work = Effect.runPromiseExit(
    upstreamResponse(response, ready, () => {}).pipe(Effect.scoped)
  )
  const output = await Effect.runPromise(Deferred.await(ready))
  await new Promise((done) => setTimeout(done, 20))
  expect(pulls).toBeLessThanOrEqual(7)
  await output.body!.cancel()
  await work
  expect(cancelled).toBe(true)
})
it("preserves response bytes and status while inspecting only one first-text marker", async () => {
  const bytes = new TextEncoder().encode(
    ': keepalive\ndata: {"type":"response.output_text.delta","delta":"hello"}\n\n'
  )
  const ready = Effect.runSync(Deferred.make<Response>())
  const stages: string[] = []
  const work = Effect.runPromiseExit(
    upstreamResponse(
      new Response(bytes, {
        status: 202,
        headers: { "x-upstream": "retained" },
      }),
      ready,
      (stage) => stages.push(stage)
    ).pipe(Effect.scoped)
  )
  const response = await Effect.runPromise(Deferred.await(ready))
  expect(response.status).toBe(202)
  expect(response.headers.get("x-upstream")).toBe("retained")
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(stages).toEqual(["upstream-text"])
  expect((await work)._tag).toBe("Success")
})

it("joins one cleanup when cancellation overlaps EOF before remote close settles", async () => {
  const entered = deferred(),
    held = deferred()
  const remote = {
    response: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.close()
          },
        })
      ),
    cancel: vi.fn(async () => {
      entered.resolve()
      await held.promise
    }),
    [Symbol.dispose]: vi.fn(),
  }
  const response = await observedUpstreamFetch(
    { start: async () => remote },
    new Request("https://api.openai.com/v1/responses", { method: "POST" }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  const reader = response.body!.getReader()
  const reading = reader.read()
  await entered.promise
  const cancelling = reader.cancel()
  held.resolve()
  const results = await Promise.allSettled([reading, cancelling])
  expect(results.map((result) => result.status)).toEqual([
    "fulfilled",
    "fulfilled",
  ])
  expect(remote.cancel).toHaveBeenCalledTimes(1)
  expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

it("releases a late response acquired after pre-header cancellation", async () => {
  let respond!: (response: Response) => void
  const headers = new Promise<Response>((done) => {
    respond = done
  })
  const released = vi.fn()
  const remote = {
    response: () => headers,
    cancel: vi.fn(async () => {}),
    [Symbol.dispose]: vi.fn(),
  }
  const abort = new AbortController()
  const pending = observedUpstreamFetch(
    { start: async () => remote },
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: abort.signal,
    }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await Promise.resolve()
  abort.abort()
  await Promise.resolve()
  respond(new Response(new ReadableStream({ cancel: released })))
  await expect(pending).rejects.toThrow()
  expect(released).toHaveBeenCalledTimes(1)
  expect(remote.cancel).toHaveBeenCalledTimes(1)
  expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

it("fences cleanup reentry when native reader cancellation aborts the request", async () => {
  const abort = new AbortController()
  const remote = {
    response: async () =>
      new Response(
        new ReadableStream({
          cancel() {
            abort.abort()
          },
        })
      ),
    cancel: vi.fn(async () => {}),
    [Symbol.dispose]: vi.fn(),
  }
  const response = await observedUpstreamFetch(
    { start: async () => remote },
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: abort.signal,
    }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await response.body!.cancel()
  expect(remote.cancel).toHaveBeenCalledTimes(1)
  expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

it("owns the actual relay through response bytes and a separate marker flush", async () => {
  const markers: string[] = [],
    retained: Promise<void>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          'data: {"type":"response.output_text.delta","delta":"synthetic"}\n\n',
          { status: 202 }
        )
    )
  )
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const remote = relay.start(
    {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: [],
      body: null,
    },
    new WritableStream({
      write(bytes) {
        markers.push(new TextDecoder().decode(bytes))
      },
    }),
    { turnId: "turn", attemptId: "attempt" }
  )
  const response = await remote.response()
  expect(response.status).toBe(202)
  expect(await response.text()).toContain('"delta":"synthetic"')
  await remote.cancel()
  await Promise.all(retained)
  expect(markers.map((line) => JSON.parse(line.slice(6)).stage)).toEqual([
    "dispatch",
    "headers",
    "upstream-text",
    "complete",
  ])
})

it("the actual relay joins interrupted dispatch and retains a late compound Cause", async () => {
  const entered = deferred(),
    interrupted = deferred(),
    held = deferred()
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        request.signal.addEventListener(
          "abort",
          () => {
            interrupted.resolve()
            resolve()
          },
          { once: true }
        )
      )
      await held.promise
      throw Cause.combine(
        Cause.fail("late checked dispatch"),
        Cause.combine(
          Cause.die("late dispatch defect"),
          Cause.die(new DOMException("compound abort remains", "AbortError"))
        )
      )
    })
  )
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  const retained: Promise<void>[] = []
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const remote = relay.start(
    {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: [],
      body: null,
    },
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await entered.promise
  let joined = false
  const closing = remote
    .cancel()
    .then(
      () => undefined,
      (cause: unknown) => cause
    )
    .finally(() => {
      joined = true
    })
  await interrupted.promise
  await Promise.resolve()
  expect(joined).toBe(false)
  held.resolve()
  const cause = await closing
  expect(Cause.isCause(cause)).toBe(true)
  if (Cause.isCause(cause)) {
    expect(Cause.pretty(cause)).toContain("late checked dispatch")
    expect(Cause.pretty(cause)).toContain("late dispatch defect")
    expect(Cause.pretty(cause)).toContain("compound abort remains")
    expect(cause.reasons.length).toBeGreaterThanOrEqual(3)
  }
  await Promise.all(retained)
})

it("joins admission cancellation before releasing its late remote handle", async () => {
  const admitted = deferred(),
    started = deferred(),
    closed = deferred()
  const remote = {
    response: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.close()
          },
        })
      ),
    cancel: vi.fn(async () => {
      closed.resolve()
    }),
    [Symbol.dispose]: vi.fn(),
  }
  const abort = new AbortController()
  const pending = observedUpstreamFetch(
    {
      start: async () => {
        started.resolve()
        await admitted.promise
        return remote
      },
    },
    new Request("https://api.openai.com/v1/responses", {
      method: "POST",
      signal: abort.signal,
    }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  const rejected = pending.then(
    () => false,
    () => true
  )
  await started.promise
  abort.abort()
  await Promise.resolve()
  expect(remote.cancel).not.toHaveBeenCalled()
  admitted.resolve()
  await closed.promise
  expect(await rejected).toBe(true)
  expect(remote.cancel).toHaveBeenCalledTimes(1)
  expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

it("remote cleanup joins both failures and keeps the full native Cause", async () => {
  const held = deferred(),
    cancelled = deferred()
  const remote = {
    response: async () =>
      new Response(
        new ReadableStream({
          cancel: async () => {
            cancelled.resolve()
            await held.promise
            throw Cause.combine(
              Cause.fail("reader checked"),
              Cause.die("reader defect")
            )
          },
        })
      ),
    cancel: vi.fn(async () => {
      throw Cause.die("remote defect")
    }),
    [Symbol.dispose]: vi.fn(),
  }
  const response = await observedUpstreamFetch(
    { start: async () => remote },
    new Request("https://api.openai.com/v1/responses", { method: "POST" }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  let joined = false
  const closing = response
    .body!.cancel()
    .then(
      () => undefined,
      (cause: unknown) => cause
    )
    .finally(() => {
      joined = true
    })
  await cancelled.promise
  expect(remote.cancel).toHaveBeenCalledTimes(1)
  expect(joined).toBe(false)
  held.resolve()
  const cause = await closing
  expect(Cause.isCause(cause)).toBe(true)
  if (Cause.isCause(cause)) {
    expect(Cause.pretty(cause)).toContain("reader checked")
    expect(Cause.pretty(cause)).toContain("reader defect")
    expect(Cause.pretty(cause)).toContain("remote defect")
  }
  expect(remote[Symbol.dispose]).toHaveBeenCalledTimes(1)
})

it("acknowledges body cancellation across the actual relay and caller while a native read is pending", async () => {
  const cancelled = vi.fn()
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(": headers\n\n"))
            },
            cancel: cancelled,
          })
        )
    )
  )
  const retained: Promise<void>[] = []
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const response = await observedUpstreamFetch(
    { start: async (...args) => relay.start(...args) },
    new Request("https://api.openai.com/v1/responses", { method: "POST" }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await response.body!.cancel()
  await Promise.all(retained)
  expect(cancelled).toHaveBeenCalledTimes(1)
})

it("acknowledges the native pending-read cancellation rejection after joining that read", async () => {
  const read = deferred(),
    joined = deferred()
  let rejectRead!: (cause: unknown) => void
  const pending = new Promise<ReadableStreamReadResult<Uint8Array>>(
    (_resolve, reject) => {
      rejectRead = reject
    }
  )
  const released = vi.fn()
  const source = new Response()
  Object.defineProperty(source, "body", {
    value: {
      getReader: () => ({
        read: () => {
          read.resolve()
          return pending
        },
        cancel: async () => {
          rejectRead(new Error("Stream was cancelled."))
          joined.resolve()
        },
        releaseLock: released,
      }),
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => source)
  )
  const retained: Promise<void>[] = []
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const response = await observedUpstreamFetch(
    { start: async (...args) => relay.start(...args) },
    new Request("https://api.openai.com/v1/responses", { method: "POST" }),
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await read.promise
  await response.body!.cancel()
  await joined.promise
  await Promise.all(retained)
  expect(released).toHaveBeenCalledTimes(1)
})

it("acknowledges expected native cancellation but reports an interrupted diagnostic outcome", async () => {
  const entered = deferred(),
    markers: string[] = [],
    retained: Promise<void>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      )
      throw new DOMException("The operation was aborted.", "AbortError")
    })
  )
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const remote = relay.start(
    {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: [],
      body: null,
    },
    new WritableStream({
      write(bytes) {
        markers.push(JSON.parse(new TextDecoder().decode(bytes).slice(6)).stage)
      },
    }),
    { turnId: "turn", attemptId: "attempt" }
  )
  await entered.promise
  await remote.cancel()
  await Promise.all(retained)
  expect(markers).toEqual(["dispatch", "failed"])
})

it("does not acknowledge an arbitrary native rejection as cancellation", async () => {
  const entered = deferred(),
    retained: Promise<void>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (request: Request) => {
      entered.resolve()
      await new Promise<void>((resolve) =>
        request.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      )
      throw new Error("Unrelated native failure")
    })
  )
  const relay = new UpstreamRelay({} as ExecutionContext, {})
  Object.defineProperty(relay, "ctx", {
    value: { waitUntil: (work: Promise<void>) => retained.push(work) },
  })
  const remote = relay.start(
    {
      url: "https://api.openai.com/v1/responses",
      method: "POST",
      headers: [],
      body: null,
    },
    new WritableStream(),
    { turnId: "turn", attemptId: "attempt" }
  )
  await entered.promise
  const cause = await remote.cancel().then(
    () => undefined,
    (cause: unknown) => cause
  )
  expect(Cause.isCause(cause)).toBe(true)
  if (Cause.isCause(cause)) expect(Cause.hasDies(cause)).toBe(true)
  await Promise.all(retained)
})
