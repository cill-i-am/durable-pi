import { Cause, Context, Effect, Exit, Scope } from "effect"
import { expect, it, vi } from "vitest"

import { makeSessionFetch, sessionFetch } from "../src/auth/session-fetch"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
it("waits for old session reads and defers polling until the replacement cookie arrives", async () => {
  const oldRead = deferred<Response>(),
    verify = deferred<Response>()
  let cookie = "old"
  const calls: string[] = []
  const nativeFetch = vi.fn(async (input: string | URL | Request) => {
    const path = String(input)
    calls.push(path)
    if (calls.length === 1) return oldRead.promise
    if (path.endsWith("verify-totp")) {
      await verify.promise
      cookie = "new"
      return new Response("verified")
    }
    return new Response(cookie)
  })
  const fetch = sessionFetch(nativeFetch)
  const before = fetch("/api/auth/get-session")
  const changing = fetch("/api/auth/two-factor/verify-totp", { method: "POST" })
  const during = fetch("/api/auth/get-session")
  // Actor admission is asynchronous; observe native entry before checking the barrier.
  await vi.waitFor(() => expect(calls).toHaveLength(1))
  expect(calls).toEqual(["/api/auth/get-session"])
  oldRead.resolve(new Response("old"))
  await before
  await vi.waitFor(() => expect(calls).toHaveLength(2))
  expect(calls[1]).toBe("/api/auth/two-factor/verify-totp")
  verify.resolve(new Response())
  await changing
  expect(await (await during).text()).toBe("new")
})
it("unblocks session recovery after failed factor requests", async () => {
  const failure = deferred<Response>()
  const nativeFetch = vi.fn((input) =>
    String(input).endsWith("disable")
      ? failure.promise
      : Promise.resolve(new Response("session"))
  )
  const fetch = sessionFetch(nativeFetch as typeof globalThis.fetch)
  const changing = fetch("/api/auth/two-factor/disable", {
    method: "POST",
  }).catch(() => null)
  const read = fetch("/api/auth/get-session")
  failure.reject(new Error("Connection interrupted"))
  await changing
  expect(await (await read).text()).toBe("session")
})

it("coalesces simultaneous reads without caching a later authorization decision", async () => {
  const first = deferred<Response>()
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(first.promise)
    .mockResolvedValue(new Response("revoked"))
  const fetch = sessionFetch(native)
  const a = fetch("/api/auth/get-session"),
    b = fetch("/api/auth/get-session")
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
  first.resolve(new Response("signed in"))
  expect(await (await a).text()).toBe("signed in")
  expect(await (await b).text()).toBe("signed in")
  expect(await (await fetch("/api/auth/get-session")).text()).toBe("revoked")
  expect(native).toHaveBeenCalledTimes(2)
})
it("does not let one subscriber abort another, or share different session queries", async () => {
  const first = deferred<Response>(),
    controller = new AbortController()
  const native = vi.fn<typeof globalThis.fetch>().mockReturnValue(first.promise)
  const fetch = sessionFetch(native)
  const a = fetch("/api/auth/get-session", { signal: controller.signal }).catch(
    () => "aborted"
  )
  const b = fetch("/api/auth/get-session")
  controller.abort()
  expect(await a).toBe("aborted")
  first.resolve(new Response("current"))
  expect(await (await b).text()).toBe("current")
  await fetch("/api/auth/get-session?disableRefresh=true")
  expect(native).toHaveBeenCalledTimes(2)
})
it("honors Retry-After without sleeping or retrying, then permits fresh reads", async () => {
  vi.useFakeTimers()
  try {
    const native = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(null, { status: 429, headers: { "Retry-After": "10" } })
      )
      .mockResolvedValue(new Response("current"))
    const fetch = sessionFetch(native)
    expect((await fetch("/api/auth/get-session")).status).toBe(429)
    expect((await fetch("/api/auth/get-session")).status).toBe(429)
    expect(native).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(10_001)
    expect((await fetch("/api/auth/get-session")).status).toBe(200)
    expect(native).toHaveBeenCalledTimes(2)
  } finally {
    vi.useRealTimers()
  }
})
it("holds new reads during sign-out as well as factor rotation", async () => {
  const signout = deferred<Response>()
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(signout.promise)
    .mockResolvedValue(Response.json(null))
  const fetch = sessionFetch(native)
  const changing = fetch("/api/auth/sign-out", { method: "POST" })
  const read = fetch("/api/auth/get-session")
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
  signout.resolve(new Response())
  await changing
  expect(await (await read).json()).toBeNull()
})

it.each(["POST", "DELETE"])(
  "orders avatar %s before fresh profile reads so polling cannot restore the old image",
  async (method) => {
    const previous = deferred<Response>()
    const mutation = deferred<Response>()
    let image: string | null = "old-photo"
    const native = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async (input) => {
        if (native.mock.calls.length === 1) return previous.promise
        if (String(input) === "/api/account/avatar") {
          await mutation.promise
          image = method === "POST" ? "new-photo" : null
          return Response.json({ image })
        }
        return Response.json({ image })
      })
    const fetch = sessionFetch(native)
    const before = fetch("/api/auth/get-session")
    const save = fetch("/api/account/avatar", { method })
    const during = fetch("/api/auth/get-session")
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
    previous.resolve(Response.json({ image: "old-photo" }))
    await before
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2))
    mutation.resolve(new Response())
    await save
    expect(await (await during).json()).toEqual({
      image: method === "POST" ? "new-photo" : null,
    })
  }
)

it("keeps all queued rotations ahead of polling when the first mutation rejects", async () => {
  const read = deferred<Response>()
  const first = deferred<Response>()
  const second = deferred<Response>()
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(read.promise)
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise)
    .mockResolvedValue(new Response("new cookie"))
  const fetch = sessionFetch(native)
  const old = fetch("/api/auth/get-session")
  const a = fetch("/api/auth/change-password", { method: "POST" }).catch(
    (error: unknown) => error
  )
  const polling = fetch("/api/auth/get-session")
  const b = fetch("/api/auth/sign-out", { method: "POST" })
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
  read.resolve(new Response("old cookie"))
  await old
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2))
  const failure = new Error("offline")
  first.reject(failure)
  expect(await a).toBe(failure)
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(3))
  expect(native.mock.calls[2]?.[0]).toBe("/api/auth/sign-out")
  second.resolve(new Response("signed out"))
  await b
  expect(await (await polling).text()).toBe("new cookie")
  expect(native.mock.calls.map(([input]) => input)).toEqual([
    "/api/auth/get-session",
    "/api/auth/change-password",
    "/api/auth/sign-out",
    "/api/auth/get-session",
  ])
})

it("uses normalized headers and credentials in the read identity and leaves native input intact", async () => {
  const response = deferred<Response>()
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValue(response.promise)
  const fetch = sessionFetch(native)
  const request = new Request("https://example.test/api/auth/get-session", {
    headers: { "x-second": "2", "x-first": "1" },
    credentials: "include",
  })
  const a = fetch(request)
  const b = fetch(request.url, {
    headers: { "x-first": "1", "x-second": "2" },
    credentials: "include",
  })
  const c = fetch(request.url, {
    headers: { "x-first": "different", "x-second": "2" },
    credentials: "include",
  })
  const d = fetch(request.url, {
    headers: request.headers,
    credentials: "omit",
  })
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(3))
  expect(native.mock.calls[0]?.[0]).toBe(request)
  response.resolve(new Response("session"))
  const results = await Promise.all([a, b, c, d])
  expect(new Set(results).size).toBe(4)
  expect(await Promise.all(results.map((result) => result.text()))).toEqual([
    "session",
    "session",
    "session",
    "session",
  ])
})

it("cancels only the queued subscriber and does not dispatch its read after rotation", async () => {
  const changing = deferred<Response>()
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockReturnValueOnce(changing.promise)
    .mockResolvedValue(new Response("current"))
  const fetch = sessionFetch(native)
  const rotation = fetch("/api/auth/sign-out", { method: "POST" })
  const controller = new AbortController()
  const cancelled = fetch("/api/auth/get-session?cancelled", {
    signal: controller.signal,
  }).catch((error: unknown) => error)
  const survivor = fetch("/api/auth/get-session")
  await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
  const reason = new Error("caller left")
  controller.abort(reason)
  expect(await cancelled).toBe(reason)
  expect(native.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
  changing.resolve(new Response())
  await rotation
  expect(await (await survivor).text()).toBe("current")
  expect(native.mock.calls.map(([input]) => input)).toEqual([
    "/api/auth/sign-out",
    "/api/auth/get-session",
  ])
})

it("retains exact native deadlines and combines only mutation caller cancellation", async () => {
  const timers: { ms: number; controller: AbortController }[] = []
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController()
    timers.push({ ms, controller })
    return controller.signal
  })
  try {
    const old = deferred<Response>()
    const mutation = deferred<Response>()
    const native = vi
      .fn<typeof globalThis.fetch>()
      .mockReturnValueOnce(old.promise)
      .mockReturnValueOnce(mutation.promise)
    const fetch = sessionFetch(native)
    const caller = new AbortController()
    const read = fetch("/api/auth/get-session", {
      signal: caller.signal,
    }).catch((error: unknown) => error)
    const shared = fetch("/api/auth/get-session")
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(1))
    caller.abort("left")
    expect(await read).toBe("left")
    expect(native.mock.calls[0]?.[1]?.signal?.aborted).toBe(false)
    timers[0]?.controller.abort(new DOMException("deadline", "TimeoutError"))
    expect(native.mock.calls[0]?.[1]?.signal?.reason.name).toBe("TimeoutError")
    old.resolve(new Response("read"))
    await shared
    const writer = new AbortController()
    const write = fetch("/api/auth/verify", {
      method: "POST",
      signal: writer.signal,
    })
    await vi.waitFor(() => expect(native).toHaveBeenCalledTimes(2))
    writer.abort("write cancelled")
    expect(native.mock.calls[1]?.[1]?.signal?.reason).toBe("write cancelled")
    expect(timers.map(({ ms }) => ms)).toEqual([15_000, 30_000])
    mutation.resolve(new Response())
    await write
  } finally {
    timeout.mockRestore()
  }
})

it("retains cooldown after native rejection but resets it after any mutation Response", async () => {
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(
      new Response(null, { status: 429, headers: { "Retry-After": "60" } })
    )
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
    .mockResolvedValue(new Response("current"))
  const fetch = sessionFetch(native)
  expect((await fetch("/api/auth/get-session")).status).toBe(429)
  await expect(fetch("/api/auth/verify", { method: "POST" })).rejects.toThrow(
    "offline"
  )
  expect((await fetch("/api/auth/get-session")).status).toBe(429)
  expect(native).toHaveBeenCalledTimes(2)
  expect((await fetch("/api/auth/verify", { method: "POST" })).status).toBe(403)
  expect(await (await fetch("/api/auth/get-session")).text()).toBe("current")
  expect(native).toHaveBeenCalledTimes(4)
})

it.each([
  [null, "60"],
  ["invalid", "60"],
  ["0", "1"],
  ["Fri, 23 Oct 2026 12:00:10 GMT", "10"],
])("preserves Retry-After parsing for %s", async (retry, expected) => {
  const now = vi
    .spyOn(Date, "now")
    .mockReturnValue(Date.parse("2026-10-23T12:00:00Z"))
  try {
    const native = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: retry === null ? {} : { "Retry-After": retry },
      })
    )
    const fetch = sessionFetch(native)
    await fetch("/api/auth/get-session")
    expect(
      (await fetch("/api/auth/get-session")).headers.get("Retry-After")
    ).toBe(expected)
    expect(native).toHaveBeenCalledTimes(1)
  } finally {
    now.mockRestore()
  }
})

it("joins native shutdown and preserves the returned response body for its consumer", async () => {
  const scope = Scope.makeUnsafe()
  const entered = deferred<AbortSignal>()
  const work = deferred<Response>()
  const cancel = vi.fn()
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("body"))
        controller.close()
      },
      cancel,
    })
  )
  const native = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation((_input, init) => {
      entered.resolve(init!.signal!)
      return work.promise
    })
  const fetch = Effect.runSync(
    makeSessionFetch(native).pipe(Effect.provideService(Scope.Scope, scope))
  )
  const read = fetch("/api/auth/get-session")
  const queued = fetch("/api/auth/sign-out", { method: "POST" }).catch(
    (error: unknown) => error
  )
  const signal = await entered.promise
  let closed = false
  const closing = Effect.runPromise(Scope.close(scope, Exit.void)).then(() => {
    closed = true
  })
  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  expect(closed).toBe(false)
  expect(await queued).toMatchObject({ name: "AbortError" })
  work.resolve(response)
  const delivered = await read
  await closing
  expect(native).toHaveBeenCalledTimes(1)
  expect(cancel).not.toHaveBeenCalled()
  expect(await delivered.text()).toBe("body")
  await expect(fetch("/api/auth/get-session")).rejects.toMatchObject({
    name: "AbortError",
  })
})

it("retains a complete annotated late native Cause while shutdown joins it", async () => {
  const scope = Scope.makeUnsafe()
  const entered = deferred<AbortSignal>()
  const work = deferred<Response>()
  const fetch = Effect.runSync(
    makeSessionFetch((_input, init) => {
      entered.resolve(init!.signal!)
      return work.promise
    }).pipe(Effect.provideService(Scope.Scope, scope))
  )
  const read = fetch("/api/auth/get-session").catch((error: unknown) => error)
  const signal = await entered.promise
  const closing = Effect.runPromiseExit(Scope.close(scope, Exit.void))
  await vi.waitFor(() => expect(signal.aborted).toBe(true))
  const annotation = Context.Service<string>("c1/native-annotation")
  const cause = Cause.fromReasons([
    Cause.makeFailReason("native checked failure"),
    Cause.makeInterruptReason(99123).annotate(
      Context.make(annotation, "retained")
    ),
  ])
  work.reject(cause)
  expect(await read).toBe(cause)
  const exit = await closing
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Die" &&
          typeof reason.defect === "object" &&
          reason.defect !== null &&
          "_tag" in reason.defect &&
          reason.defect._tag === "Fail" &&
          "error" in reason.defect &&
          reason.defect.error === "native checked failure"
      )
    ).toBe(true)
    const interrupt = exit.cause.reasons.find(
      (reason) => reason._tag === "Interrupt" && reason.fiberId === 99123
    )
    expect(interrupt?.annotations.get("c1/native-annotation")).toBe("retained")
  }
})

it("does not alter unrelated native fetch input, signal or response identity", async () => {
  const response = new Response("native")
  const native = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response)
  const fetch = sessionFetch(native)
  const init = {
    method: "POST",
    signal: new AbortController().signal,
    credentials: "omit" as const,
  }
  expect(await fetch("/api/unrelated", init)).toBe(response)
  expect(native.mock.calls[0]).toEqual(["/api/unrelated", init])
})
