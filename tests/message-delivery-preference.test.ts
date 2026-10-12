import { afterEach, beforeEach, expect, it, vi } from "vitest"

const key = "durable-pi:message-delivery"
let saved: Map<string, string>
let browser: EventTarget & { localStorage: Storage }
beforeEach(() => {
  vi.resetModules()
  saved = new Map()
  browser = Object.assign(new EventTarget(), {
    localStorage: {
      getItem: (name: string) => saved.get(name) ?? null,
      setItem: (name: string, value: string) => void saved.set(name, value),
    } as Storage,
  })
  vi.stubGlobal("window", browser)
})
afterEach(() => vi.unstubAllGlobals())

it("defaults to steering, ignores invalid saved values and restores an explicit choice", async () => {
  const preference =
    await import("../src/features/conversation/delivery-preference")
  expect(preference.messageDeliveryDefault()).toBe("steer")
  saved.set(key, "invalid")
  expect(preference.messageDeliveryDefault()).toBe("steer")
  const changed = vi.fn()
  browser.addEventListener("durable-pi:message-delivery-change", changed)
  preference.setMessageDeliveryDefault("followUp")
  expect(changed).toHaveBeenCalledOnce()
  vi.resetModules()
  const restored =
    await import("../src/features/conversation/delivery-preference")
  expect(restored.messageDeliveryDefault()).toBe("followUp")
  // Reads changes made by another tab; clearing the preference returns to Steer.
  saved.set(key, "steer")
  expect(restored.messageDeliveryDefault()).toBe("steer")
  saved.delete(key)
  expect(restored.messageDeliveryDefault()).toBe("steer")
})

it("retains the current page choice when saving fails instead of reading a stale value", async () => {
  const preference =
    await import("../src/features/conversation/delivery-preference")
  saved.set(key, "followUp")
  browser.localStorage.setItem = () => {
    throw new Error("Storage unavailable")
  }
  preference.setMessageDeliveryDefault("steer")
  expect(preference.messageDeliveryDefault()).toBe("steer")
  preference.setMessageDeliveryDefault("followUp")
  expect(preference.messageDeliveryDefault()).toBe("followUp")
})

it("can be read without a browser during server rendering", async () => {
  vi.unstubAllGlobals()
  const preference =
    await import("../src/features/conversation/delivery-preference")
  expect(preference.messageDeliveryDefault()).toBe("steer")
})
