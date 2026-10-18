import { afterEach, expect, it, vi } from "vitest"

import { ClientErrorReport } from "../src/observability/client-errors"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function fixture(status = 204) {
  const target = new EventTarget()
  vi.stubGlobal(
    "window",
    Object.assign(target, {
      location: {
        origin: "https://pi.example.invalid",
        pathname: "/agents/private-id",
      },
    })
  )
  vi.stubGlobal("navigator", { onLine: true })
  const fetch = vi.fn<typeof globalThis.fetch>(
    async () => new Response(null, { status })
  )
  vi.stubGlobal("fetch", fetch)
  const browser = await import("../src/observability/browser")
  return { ...browser, fetch, target }
}
it("deduplicates a React boundary and its recovery screen, keeping the component trace", async () => {
  const { fetch, reportClientError } = await fixture()
  const error = new TypeError(
    "Cannot read properties of undefined (reading 'private')"
  )
  const first = reportClientError(error, {
    componentStack:
      "at Chat (https://pi.example.invalid/assets/chat-AbCd1234.js:23:45)",
  })
  const second = reportClientError(error)
  expect(first).toBe(second)
  expect(await first).toMatch(/^[a-f0-9-]{36}$/)
  expect(fetch).toHaveBeenCalledOnce()
  const payload = JSON.parse(
    String(fetch.mock.calls[0]?.[1]?.body)
  ) as ClientErrorReport
  expect(payload.components).toEqual([
    { file: "/assets/chat-AbCd1234.js", line: 23, column: 45 },
  ])
  expect(payload.page).toBe("chat")
  expect(JSON.stringify(payload)).not.toContain("private")
})
it("caps an error loop at five reports per minute", async () => {
  const { fetch, reportClientError } = await fixture()
  await Promise.all(
    Array.from({ length: 20 }, () => reportClientError(new Error("synthetic")))
  )
  expect(fetch).toHaveBeenCalledTimes(5)
})
it.each([200, 401, 503])(
  "does not claim a report was recorded after HTTP %i",
  async (status) => {
    const { reportClientError } = await fixture(status)
    expect(await reportClientError(new Error("synthetic"))).toBeUndefined()
  }
)
it("settles network failure and hostile error getters without creating another exception", async () => {
  const { fetch, reportClientError } = await fixture()
  fetch.mockRejectedValue(new Error("network down"))
  expect(await reportClientError(new Error("synthetic"))).toBeUndefined()
  expect(
    await reportClientError({
      get message() {
        throw new Error("getter")
      },
    })
  ).toBeUndefined()
  expect(fetch).toHaveBeenCalledOnce()
})
it("installs and removes global exception and rejection listeners", async () => {
  const { fetch, listenForClientErrors, target } = await fixture()
  const stop = listenForClientErrors()
  target.dispatchEvent(
    Object.assign(new Event("error"), { error: new TypeError("synthetic") })
  )
  target.dispatchEvent(
    Object.assign(new Event("unhandledrejection"), {
      reason: new Error("synthetic rejection"),
    })
  )
  expect(fetch).toHaveBeenCalledTimes(2)
  stop()
  target.dispatchEvent(
    Object.assign(new Event("error"), { error: new Error("later") })
  )
  expect(fetch).toHaveBeenCalledTimes(2)
})
it("does no IO or shared request bookkeeping during SSR", async () => {
  vi.stubGlobal("fetch", vi.fn())
  const { reportClientError } = await import("../src/observability/browser")
  expect(await reportClientError(new Error("synthetic"))).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
})
