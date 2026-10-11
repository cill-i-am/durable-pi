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
