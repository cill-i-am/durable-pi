import { describe, expect, it } from "vitest"

import {
  armBackgroundRecovery,
  observeBackgroundRecovery,
  readBackgroundRecovery,
} from "../src/delegation/background-recovery.machine"

describe("background durable discovery", () => {
  it("retains a later admission lease after an early empty scan", () => {
    const first = armBackgroundRecovery(undefined, 100, 1000, "first")
    const later = armBackgroundRecovery(first, 100, 2000, "later")
    expect(
      observeBackgroundRecovery(later, 100, { now: 500, next: null })
    ).toEqual([{ type: "reschedule", at: 2000 }])
    expect(later.token).toBe("later")
    expect(
      observeBackgroundRecovery(later, 100, { now: 500, next: 700 })
    ).toEqual([{ type: "reschedule", at: 700 }])
    expect(
      observeBackgroundRecovery(later, 100, { now: 2000, next: null })
    ).toEqual([])
  })
  it("restores legacy jobs but rejects malformed events and future payloads", () => {
    expect(readBackgroundRecovery(null, 100)).toMatchObject({
      armedUntil: 100,
      token: "legacy:100",
    })
    const row = armBackgroundRecovery(undefined, 100, 2000, "attempt")
    expect(
      readBackgroundRecovery(JSON.parse(JSON.stringify(row)), 100)
    ).toEqual(row)
    expect(() =>
      readBackgroundRecovery({ ...row, workflowVersion: 2 }, 100)
    ).toThrow()
    expect(() => armBackgroundRecovery(row, 100, -1, "bad")).toThrow()
    expect(() =>
      observeBackgroundRecovery(row, 100, { now: -1, next: null })
    ).toThrow()
  })
})
