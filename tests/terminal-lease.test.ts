import { describe, expect, it, vi } from "vitest"

import { maintainSessionLease } from "../src/features/terminal/session-lease"
import { ApiError } from "../src/http/client"

describe("interactive terminal lease", () => {
  it("recovers from a transient renewal failure before the confirmed expiry", async () => {
    vi.useFakeTimers()
    const changed = vi.fn()
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => ({ expiresAt: Date.now() + 30000 }))
    const stop = maintainSessionLease(Date.now() + 30000, renew, changed)
    try {
      await vi.advanceTimersByTimeAsync(1)
      expect(changed).toHaveBeenLastCalledWith({
        ended: false,
        error: expect.stringContaining("Retrying"),
      })
      await vi.advanceTimersByTimeAsync(2000)
      expect(changed).toHaveBeenLastCalledWith({ ended: false, error: "" })
      await vi.advanceTimersByTimeAsync(60000)
      expect(changed.mock.calls.some(([state]) => state.ended)).toBe(false)
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
  it("expires on a hanging request and ignores its late response", async () => {
    vi.useFakeTimers()
    let resolve!: (value: { expiresAt: number }) => void
    const changed = vi.fn(),
      renew = vi.fn(
        () =>
          new Promise<{ expiresAt: number }>((r) => {
            resolve = r
          })
      )
    const stop = maintainSessionLease(Date.now() + 30000, renew, changed)
    try {
      await vi.advanceTimersByTimeAsync(30001)
      expect(changed).toHaveBeenLastCalledWith({
        ended: true,
        error: expect.stringContaining("expired"),
      })
      resolve({ expiresAt: Date.now() + 30000 })
      await vi.advanceTimersByTimeAsync(10001)
      expect(renew).toHaveBeenCalledOnce()
      expect(changed).toHaveBeenCalledOnce()
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
  it("stops on revoked authentication and on workbench disposal", async () => {
    vi.useFakeTimers()
    const changed = vi.fn(),
      renew = vi.fn().mockRejectedValue(new ApiError(401, "expired"))
    const stop = maintainSessionLease(Date.now() + 30000, renew, changed)
    try {
      await vi.advanceTimersByTimeAsync(60000)
      expect(renew).toHaveBeenCalledOnce()
      expect(changed).toHaveBeenLastCalledWith({
        ended: true,
        error: expect.stringContaining("Sign-in expired"),
      })
      stop()
    } finally {
      stop()
      vi.useRealTimers()
    }
  })
})
