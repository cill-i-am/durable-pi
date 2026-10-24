import { Cause } from "effect"
import { afterEach, expect, it, vi } from "vitest"

import { conversationConnection } from "../src/features/conversation/connection"
import { ApiError } from "../src/http/client"

vi.mock("../src/features/performance", () => ({ markReady: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

it("the real TanStack adapter replays the application cursor and terminates on access denial", async () => {
  const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(
        `data: ${JSON.stringify({ type: "CUSTOM", name: "durable-pi.cursor", value: cursor })}\n\n`,
        { headers: { "content-type": "text/event-stream" } }
      )
    )
    .mockResolvedValueOnce(new Response("Denied", { status: 403 }))
  vi.stubGlobal("fetch", fetch)
  const delivered: unknown[] = []
  let error: unknown
  try {
    for await (const chunk of conversationConnection("owner-agent")
      .subscribe!())
      delivered.push(chunk)
  } catch (cause) {
    error = cause
  }
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(String(fetch.mock.calls[0]![0])).toContain("protocol=tanstack")
  expect(String(fetch.mock.calls[1]![0])).toContain(`after=${cursor}`)
  expect(delivered).toContainEqual({
    type: "CUSTOM",
    name: "durable-pi.cursor",
    value: cursor,
  })
  expect(error).toBeInstanceOf(ApiError)
  expect((error as ApiError).status).toBe(403)
})

it("permission rejection joins unread body cleanup before exposing its terminal error", async () => {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancelling = new Promise<void>((resolve) => {
    entered = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      entered()
      return held
    },
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 401 }))
  )
  const subscription = conversationConnection("owner-agent").subscribe!()
  let settled = false
  const next = subscription[Symbol.asyncIterator]()
    .next()
    .catch((error: unknown) => {
      settled = true
      return error
    })
  await cancelling
  expect(settled).toBe(false)
  release()
  expect(await next).toMatchObject({
    status: 401,
    message: "Your session has expired. Sign in again.",
  })
})

it("joins the SDK's unawaited reader cancellation before replacement fetch", async () => {
  let release!: () => void, entered!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancelling = new Promise<void>((resolve) => {
    entered = resolve
  })
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      },
      cancel() {
        entered()
        return held
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockResolvedValue(new Response("Denied", { status: 403 }))
  vi.stubGlobal("fetch", fetch)
  let settled = false
  const completed = (async () => {
    try {
      for await (const _chunk of conversationConnection("owner-agent")
        .subscribe!()) {
        /* consume */
      }
    } catch {
      /* permission rejection ends the next request */
    } finally {
      settled = true
    }
  })()
  try {
    await cancelling
    await new Promise((resolve) => setTimeout(resolve, 350))
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  } finally {
    release()
    await completed
  }
})

it("a native source read error remains retryable after its reader is released", async () => {
  const broken = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("temporary connection loss"))
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(broken)
    .mockResolvedValue(new Response("Denied", { status: 403 }))
  vi.stubGlobal("fetch", fetch)
  let terminal: unknown
  try {
    for await (const _chunk of conversationConnection("owner-agent")
      .subscribe!()) {
      /* consume */
    }
  } catch (cause) {
    terminal = cause
  }
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(terminal).toMatchObject({ status: 403 })
})

it("late compound reader cancellation failure survives caller abort and prevents replacement", async () => {
  const controller = new AbortController()
  let reject!: (cause: unknown) => void, entered!: () => void
  const held = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  const cancelling = new Promise<void>((resolve) => {
    entered = resolve
  })
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(stream) {
        stream.enqueue(new TextEncoder().encode("data: [DONE]\n\n"))
      },
      cancel() {
        entered()
        return held
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
  const fetch = vi.fn(async () => response)
  vi.stubGlobal("fetch", fetch)
  const defect = new Error("late response cleanup")
  const compound = Cause.combine(
    Cause.fail("checked cleanup"),
    Cause.die(defect)
  )
  const completed = (async () => {
    try {
      for await (const _chunk of conversationConnection("owner-agent")
        .subscribe!(controller.signal)) {
        /* consume */
      }
    } catch (cause) {
      return cause
    }
  })()
  await cancelling
  controller.abort()
  reject(compound)
  const result = await completed
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(
    Cause.isCause(result) &&
      result.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
})

it("the SDK cannot flatten a compound native reader rejection into a retryable error", async () => {
  const defect = new Error("native reader defect")
  const compound = Cause.combine(
    Cause.fail("checked native read"),
    Cause.die(defect)
  )
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(compound)
      },
    }),
    { headers: { "content-type": "text/event-stream" } }
  )
  const fetch = vi.fn(async () => response)
  vi.stubGlobal("fetch", fetch)
  const completed = (async () => {
    try {
      for await (const _chunk of conversationConnection("owner-agent")
        .subscribe!()) {
        /* consume */
      }
    } catch (cause) {
      return cause
    }
  })()
  const result = await completed
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(
    Cause.isCause(result) &&
      result.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
  ).toBe(true)
  expect(
    Cause.isCause(result) &&
      result.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          typeof reason.error === "object" &&
          reason.error !== null &&
          "error" in reason.error &&
          reason.error.error === "checked native read"
      )
  ).toBe(true)
})

it.each([401, 403, 404])(
  "authorization denial %i retains its cleanup Cause and cannot authorize another fetch",
  async (status) => {
    const defect = new Error("denied response cleanup")
    const compound = Cause.combine(
      Cause.fail("checked denied cleanup"),
      Cause.die(defect)
    )
    const denied = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          throw compound
        },
      }),
      { status }
    )
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(denied)
      .mockResolvedValue(new Response("Denied", { status: 403 }))
    vi.stubGlobal("fetch", fetch)
    let terminal: unknown
    try {
      for await (const _chunk of conversationConnection("owner-agent")
        .subscribe!()) {
        /* consume */
      }
    } catch (cause) {
      terminal = cause
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(Cause.isCause(terminal)).toBe(true)
    if (!Cause.isCause(terminal)) throw new Error("Expected compound Cause")
    expect(terminal.reasons).toHaveLength(3)
    expect(
      terminal.reasons.some(
        (reason) => reason._tag === "Die" && reason.defect === defect
      )
    ).toBe(true)
    const failures = terminal.reasons.flatMap((reason) =>
      reason._tag === "Fail" &&
      typeof reason.error === "object" &&
      reason.error !== null &&
      "error" in reason.error
        ? [reason.error.error]
        : []
    )
    expect(failures).toContain("checked denied cleanup")
    const denial = failures.find((error) => error instanceof ApiError)
    expect(denial).toBeInstanceOf(ApiError)
    expect(denial).toMatchObject({ status })
  }
)
