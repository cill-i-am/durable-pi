import { Deferred, Effect } from "effect"
import { expect, it, vi } from "vitest"

import { observedUpstreamFetch } from "../src/inference/adapters/upstream-worker"

vi.mock("cloudflare:workers", () => ({
  WorkerEntrypoint: class {},
  RpcTarget: class {},
}))

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
