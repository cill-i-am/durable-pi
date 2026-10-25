import { expect, it } from "vitest"

import {
  beginToolCallback,
  settleToolCallback,
  shareToolCallback,
} from "../src/access/callback.machine"

it("shares only the immutable input of an owned callback", () => {
  const owned = beginToolCallback("original")
  expect(shareToolCallback(owned, "original")).toBe(true)
  expect(shareToolCallback(owned, "changed")).toBe(false)
  expect(shareToolCallback(settleToolCallback(owned), "original")).toBe(false)
})
it("rejects malformed callback admission data", () => {
  expect(() =>
    // @ts-expect-error Deliberately invalid native input proves boundary validation.
    shareToolCallback(beginToolCallback("original"), 42)
  ).toThrow()
})
