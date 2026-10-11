import { describe, expect, it, vi } from "vitest"
import { InteractiveSession } from "../src/terminal/session"
import { validTerminalInput } from "../src/terminal/adapters/socket"

describe("terminal transport boundary", () => {
  it("accepts only bounded binary input and a bounded resize control", () => {
    expect(validTerminalInput(new ArrayBuffer(16384))).toBe(true)
    expect(validTerminalInput(new ArrayBuffer(16385))).toBe(false)
    expect(
      validTerminalInput(JSON.stringify({ type: "resize", cols: 80, rows: 24 }))
    ).toBe(true)
    for (const data of [
      "rm -rf /",
      '{"type":"exec","command":"whoami"}',
      '{"type":"resize","cols":1000,"rows":24}',
      '{"type":"resize","cols":80,"rows":24,"url":"https://evil.example"}',
    ])
      expect(validTerminalInput(data)).toBe(false)
  })
  it("limits authenticated renewal to the fixed session lifetime", async () => {
    vi.useFakeTimers()
    try {
      const controller = new AbortController(),
        session = new InteractiveSession("id", controller)
      const maximum = session.maximumAt
      for (let i = 0; i < 59; i++) {
        await vi.advanceTimersByTimeAsync(10000)
        session.renew()
      }
      expect(session.maximumAt).toBe(maximum)
      expect(session.expiresAt).toBe(maximum)
      await vi.advanceTimersByTimeAsync(10001)
      expect(controller.signal.aborted).toBe(true)
      expect(() => session.renew()).toThrow("ended")
    } finally {
      vi.useRealTimers()
    }
  })
})
