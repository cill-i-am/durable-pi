import { expect, it, vi } from "vitest"

import { sessionFetch } from "../src/auth/session-fetch"

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
  await Promise.resolve()
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
  expect(native).toHaveBeenCalledTimes(1)
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
  await Promise.resolve()
  expect(native).toHaveBeenCalledTimes(1)
  signout.resolve(new Response())
  await changing
  expect(await (await read).json()).toBeNull()
})
