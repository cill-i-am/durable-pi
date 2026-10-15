import { Cause } from "effect"
import { afterEach, expect, it, vi } from "vitest"
import {
  bindSessionSocket,
  sessionSocketResponse,
} from "../src/auth/adapters/session-socket"

class Socket extends EventTarget {
  send = vi.fn()
  close = vi.fn()
  message(data: string) {
    this.dispatchEvent(new MessageEvent("message", { data }))
  }
}
afterEach(() => vi.useRealTimers())
it("closes both directions when a session is revoked and stops forwarding", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket(),
    authorized = vi.fn().mockResolvedValue(false)
  bindSessionSocket(a, b, authorized)
  a.message("input")
  b.message("output")
  expect(b.send).toHaveBeenCalledWith("input")
  expect(a.send).toHaveBeenCalledWith("output")
  await vi.advanceTimersByTimeAsync(5000)
  expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  expect(b.close).toHaveBeenCalledWith(1008, "Sign in again")
  a.message("blocked")
  expect(b.send).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount()).toBe(0)
})
it("fails closed when authorization hangs or fails, and cleans up disconnected clients", async () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  bindSessionSocket(a, b, () => new Promise(() => {}))
  await vi.advanceTimersByTimeAsync(15000)
  expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  const c = new Socket(),
    d = new Socket()
  bindSessionSocket(c, d, () => Promise.reject(new Error("offline")))
  await vi.advanceTimersByTimeAsync(5000)
  expect(c.close).toHaveBeenCalledWith(1011, "Could not verify session")
  const e = new Socket(),
    f = new Socket()
  bindSessionSocket(e, f, () => Promise.resolve(true))
  e.dispatchEvent(new Event("close"))
  expect(f.close).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
it("returns an idempotent disposer that removes timers/listeners and reports every close failure", () => {
  vi.useFakeTimers()
  const a = new Socket(),
    b = new Socket()
  const first = new Error("First close failed"),
    second = new Error("Second close failed")
  const closed = bindSessionSocket(a, b, async () => true)
  a.close.mockImplementation(() => {
    throw first
  })
  b.close.mockImplementation(() => {
    throw second
  })
  let failure: unknown
  try {
    closed()
  } catch (cause) {
    failure = cause
  }
  expect(
    Cause.isCause(failure) &&
      failure.reasons.map((reason) =>
        reason._tag === "Die" ? reason.defect : reason._tag
      )
  ).toEqual([first, second])
  a.message("after teardown")
  expect(b.send).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  closed()
  expect(a.close).toHaveBeenCalledOnce()
  expect(b.close).toHaveBeenCalledOnce()
})
it("cleans up both native endpoints and the timer when upgrade response construction fails", () => {
  vi.useFakeTimers()
  const upstream = Object.assign(new Socket(), {
    accept: vi.fn(),
    binaryType: "arraybuffer" as const,
  })
  const server = Object.assign(new Socket(), {
    accept: vi.fn(),
    binaryType: "arraybuffer" as const,
  })
  vi.stubGlobal(
    "WebSocketPair",
    class {
      0 = new Socket()
      1 = server
    }
  )
  try {
    expect(() =>
      sessionSocketResponse(upstream, async () => true, vi.fn())
    ).toThrow()
    expect(upstream.close).toHaveBeenCalledOnce()
    expect(server.close).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.unstubAllGlobals()
  }
})
