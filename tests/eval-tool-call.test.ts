import { describe, expect, it } from "vitest"
import { z } from "zod"

import { toolCall } from "../evals/tool-call"

describe("archived tool-call JSON compatibility", () => {
  it.each([
    null,
    true,
    false,
    0,
    -0,
    1.25,
    "text",
    [],
    {},
    [null, { values: ["text", 3, false] }],
    { nested: { values: [{ empty: [], flag: true }, null] } },
    JSON.parse('{"__proto__":{"nested":true},"constructor":null}'),
  ])("preserves Zod JSON parsing for %j", (value) => {
    const expected = z.json().parse(value)
    expect(
      toolCall.parse({ name: "example", arguments: { value } }).arguments.value
    ).toEqual(expected)
  })

  it.each([
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol("invalid"),
    () => null,
    new Date(0),
    new Map(),
    new Set(),
  ])("rejects non-JSON values at every nesting level: %s", (value) => {
    for (const nested of [value, [value], { deeper: [{ value }] }]) {
      expect(z.json().safeParse(nested).success).toBe(false)
      expect(
        toolCall.safeParse({ name: "example", arguments: { nested } }).success
      ).toBe(false)
    }
  })

  it("keeps the required tool name and argument record", () => {
    expect(toolCall.parse({ name: "example", arguments: {} })).toEqual({
      name: "example",
      arguments: {},
    })
    for (const invalid of [
      {},
      { name: "example" },
      { arguments: {} },
      { name: 1, arguments: {} },
      { name: "example", arguments: null },
      { name: "example", arguments: [] },
    ]) {
      expect(toolCall.safeParse(invalid).success).toBe(false)
    }
  })
})
