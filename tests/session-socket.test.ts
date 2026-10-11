import { afterEach, expect, it, vi } from "vitest"
import { bindSessionSocket } from "../src/auth/session-socket"

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
  bindSessionSocket(
    a as unknown as WebSocket,
    b as unknown as WebSocket,
    authorized
  )
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
  bindSessionSocket(
    a as unknown as WebSocket,
    b as unknown as WebSocket,
    () => new Promise(() => {})
  )
  await vi.advanceTimersByTimeAsync(15000)
  expect(a.close).toHaveBeenCalledWith(1008, "Sign in again")
  const c = new Socket(),
    d = new Socket()
  bindSessionSocket(c as unknown as WebSocket, d as unknown as WebSocket, () =>
    Promise.reject(new Error("offline"))
  )
  await vi.advanceTimersByTimeAsync(5000)
  expect(c.close).toHaveBeenCalledWith(1011, "Could not verify session")
  const e = new Socket(),
    f = new Socket()
  bindSessionSocket(e as unknown as WebSocket, f as unknown as WebSocket, () =>
    Promise.resolve(true)
  )
  e.dispatchEvent(new Event("close"))
  expect(f.close).toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
