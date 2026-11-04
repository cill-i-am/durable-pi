import { describe, expect, it } from "vitest"

import {
  filterValueError,
  matchesFilter,
} from "../src/features/rich-results/table-controls"

describe("contextual table filter validation", () => {
  it("requires a value while allowing zero, negatives and fractional original units", () => {
    expect(filterValueError("", true)).toBe("Enter a value.")
    expect(filterValueError("   ", false)).toBe("Enter a value.")
    for (const value of ["0", "-12.50", "0.15", "2e3"])
      expect(filterValueError(value, true)).toBeNull()
    expect(filterValueError("Family", false)).toBeNull()
  })

  it("reports malformed and nonfinite numeric values, including a native bad-input blank", () => {
    for (const value of ["two", "NaN", "Infinity", "-Infinity", "1e999"])
      expect(filterValueError(value, true)).toBe("Enter a number.")
    expect(filterValueError("", true, true)).toBe("Enter a number.")
  })

  it("does not turn an empty numeric filter into zero in any comparison", () => {
    for (const operator of ["is", "gt", "gte", "lt", "lte"] as const) {
      for (const value of ["", " "])
        expect(matchesFilter(-1, { operator, values: [value] })).toBe(false)
    }
    expect(matchesFilter(0.15, { operator: "is", values: ["0.15"] })).toBe(true)
    expect(matchesFilter(250, { operator: "lte", values: ["250"] })).toBe(true)
  })
})
