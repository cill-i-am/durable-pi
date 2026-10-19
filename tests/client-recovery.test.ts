import { describe, expect, it, vi } from "vitest"

import { createRecovery, importFailure } from "../src/features/updates/recovery"

describe("explicit client recovery", () => {
  it("requires a different valid build and never reloads just because an update arrives", () => {
    const reload = vi.fn(),
      recovery = createRecovery("a".repeat(40), reload)
    for (const revision of [
      null,
      {},
      "development",
      "<script>",
      "a".repeat(40),
    ])
      recovery.observe(revision)
    expect(recovery.snapshot().revision).toBeNull()
    recovery.observe("b".repeat(40))
    expect(recovery.snapshot().revision).toBe("b".repeat(40))
    expect(reload).not.toHaveBeenCalled()
    // A mixed rollout response cannot hide a previously observed update.
    recovery.observe("a".repeat(40))
    expect(recovery.snapshot().revision).toBe("b".repeat(40))
  })
  it("retains independent fences and allows a single explicit reload only after all settle", () => {
    const reload = vi.fn(),
      recovery = createRecovery("a".repeat(40), reload)
    recovery.block("upload", "Wait for upload")
    recovery.block("terminal", "Save terminal")
    expect(recovery.reload()).toBe(false)
    recovery.block("upload", null)
    expect(recovery.snapshot().blocked).toBe("Save terminal")
    expect(recovery.reload()).toBe(false)
    recovery.block("terminal", null)
    recovery.connection(false)
    expect(recovery.reload()).toBe(false)
    recovery.connection(true)
    expect(recovery.reload()).toBe(true)
    expect(recovery.reload()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it("recovers a rejected browser reload and releases subscribers", () => {
    const reload = vi.fn(() => {
      throw new Error("navigation denied")
    })
    const recovery = createRecovery("a".repeat(40), reload),
      listener = vi.fn()
    const unsubscribe = recovery.subscribe(listener)
    expect(recovery.reload()).toBe(false)
    expect(recovery.snapshot().reloading).toBe(false)
    unsubscribe()
    const count = listener.mock.calls.length
    recovery.connection(false)
    expect(listener).toHaveBeenCalledTimes(count)
  })
  it("recognizes browser asset failures without reclassifying ordinary API or render errors", () => {
    for (const message of [
      "Failed to fetch dynamically imported module: /assets/settings-old.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
      "Unable to preload CSS for /assets/old.css",
      "Loading chunk 18 failed",
    ])
      expect(importFailure(new TypeError(message))).toBe(true)
    for (const error of [
      new Error("NetworkError"),
      new TypeError("Failed to fetch"),
      new Error("Synthetic workspace load failure"),
      new Error("Cannot read properties of undefined"),
      { message: "Failed to fetch dynamically imported module" },
    ])
      expect(importFailure(error)).toBe(false)
  })
})
