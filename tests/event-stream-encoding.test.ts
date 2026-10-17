import { Effect } from "effect"
import { expect, it, vi } from "vitest"

import { encodeEventStream } from "../src/auth/adapters/event-stream-encoding"

const encoder = new TextEncoder()
const request = (accept?: string) =>
  new Request("https://website.example/api/agent/events", {
    headers: accept === undefined ? {} : { "accept-encoding": accept },
  })
const source = (body: BodyInit | null = "data: synthetic\n\n") =>
  new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  })

it.each([
  [undefined, false],
  ["identity", false],
  ["br, gzip, deflate", true],
  ["GZIP;q=0.5", true],
  ["gzip;q=0", false],
  ["gzip;q=0, *;q=1", false],
  ["*;q=1", true],
  ["*;q=0", false],
  ["gzip;q=1.1", false],
  ["gzip;q=invalid", false],
])(
  "negotiates %s without changing the event contents",
  async (accept, gzip) => {
    const response = await Effect.runPromise(
      encodeEventStream(request(accept), source())
    )
    expect(response.headers.get("content-encoding")).toBe(gzip ? "gzip" : null)
    expect(response.headers.get("vary")).toBe("Accept-Encoding")
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    const body = gzip
      ? new Response(
          response.body!.pipeThrough(new DecompressionStream("gzip"))
        )
      : response
    expect(await body.text()).toBe("data: synthetic\n\n")
  }
)

it("honors the original visitor capability when Workers normalized the header", async () => {
  const incoming = request("gzip, br")
  Object.defineProperty(incoming, "cf", {
    value: { clientAcceptEncoding: "identity" },
  })
  const response = await Effect.runPromise(
    encodeEventStream(incoming, source())
  )
  expect(response.headers.has("content-encoding")).toBe(false)
  expect(await response.text()).toBe("data: synthetic\n\n")
})

it.each(["Origin", "accept-encoding", "*"])(
  "preserves existing Vary: %s and removes the identity content length",
  async (vary) => {
    const input = source()
    input.headers.set("Vary", vary)
    input.headers.set("Content-Length", "17")
    const response = await Effect.runPromise(
      encodeEventStream(request("gzip"), input)
    )
    expect(response.headers.get("Vary")).toBe(
      vary === "Origin" ? "Origin, Accept-Encoding" : vary
    )
    expect(response.headers.has("Content-Length")).toBe(false)
    await response.body!.cancel()
  }
)

it("leaves errors, ordinary responses and already encoded bodies alone", async () => {
  for (const input of [
    new Response("Unauthorized", { status: 401 }),
    Response.json({ value: "synthetic" }),
    new Response(null, { status: 204 }),
    new Response("encoded", {
      headers: {
        "content-type": "text/event-stream",
        "content-encoding": "br",
      },
    }),
  ]) {
    expect(
      await Effect.runPromise(encodeEventStream(request("gzip"), input))
    ).toBe(input)
    await input.body?.cancel()
  }
})

it("delivers small events before EOF, then propagates cancellation upstream", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let finish!: () => void
  const cancelled = new Promise<void>((resolve) => {
    finish = resolve
  })
  const close = vi.fn(() => finish())
  const input = source(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
      cancel: close,
    })
  )
  const response = await Effect.runPromise(
    encodeEventStream(request("gzip"), input)
  )
  const reader = response
    .body!.pipeThrough(new DecompressionStream("gzip"))
    .getReader()
  controller.enqueue(encoder.encode("data: first\n\n"))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    "data: first\n\n"
  )
  controller.enqueue(encoder.encode(": keepalive\n\n"))
  expect(new TextDecoder().decode((await reader.read()).value)).toBe(
    ": keepalive\n\n"
  )
  await reader.cancel()
  await cancelled
  expect(close).toHaveBeenCalledOnce()
}, 2000)

it("fails the downstream reader when the source fails after its first event", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const input = source(
    new ReadableStream<Uint8Array>({
      start(value) {
        controller = value
      },
    })
  )
  const response = await Effect.runPromise(
    encodeEventStream(request("gzip"), input)
  )
  const reader = response
    .body!.pipeThrough(new DecompressionStream("gzip"))
    .getReader()
  controller.enqueue(encoder.encode("data: first\n\n"))
  await reader.read()
  controller.error(new Error("Synthetic source failure"))
  await expect(reader.read()).rejects.toBeDefined()
}, 2000)

it("joins upstream cleanup when cancelled before the first event", async () => {
  let finish!: () => void
  const held = new Promise<void>((resolve) => {
    finish = resolve
  })
  const close = vi.fn(() => held)
  const response = await Effect.runPromise(
    encodeEventStream(
      request("gzip"),
      source(new ReadableStream({ cancel: close }))
    )
  )
  let settled = false
  const cancelled = response.body!.cancel().then(() => {
    settled = true
  })
  await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  expect(settled).toBe(false)
  finish()
  await cancelled
})

it.each([false, true])(
  "stops its source for request disconnect (already aborted: %s)",
  async (alreadyAborted) => {
    const abort = new AbortController()
    const incoming = new Request("https://website.example/api/agent/events", {
      headers: { "accept-encoding": "gzip" },
      signal: abort.signal,
    })
    if (alreadyAborted) abort.abort()
    const close = vi.fn()
    const response = await Effect.runPromise(
      encodeEventStream(incoming, source(new ReadableStream({ cancel: close })))
    )
    const reader = response.body!.getReader()
    abort.abort()
    while (!(await reader.read()).done) {}
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
  }
)

it("retains an upstream cancellation failure", async () => {
  const defect = new Error("Synthetic cancellation failure")
  const response = await Effect.runPromise(
    encodeEventStream(
      request("gzip"),
      source(
        new ReadableStream({
          cancel: () => Promise.reject(defect),
        })
      )
    )
  )
  await expect(response.body!.cancel()).rejects.toBe(defect)
})
