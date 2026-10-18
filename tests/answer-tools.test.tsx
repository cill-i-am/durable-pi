import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { builtInTools } from "../src/access/contracts"
import { RichResult } from "../src/features/rich-results/rich-result"
import { matchesFilter } from "../src/features/rich-results/table-controls"
import { lookupRoute } from "../src/rich-results/adapters/lookups"
import {
  definitions,
  parseAnswerResult,
  validateAnswerSpec,
  type AnswerProps,
} from "../src/rich-results/catalog"
import { richResultToolNames } from "../src/rich-results/contracts"
import {
  analyzeData,
  briefInput,
  createBrief,
  presentAnswerSpec,
} from "../src/rich-results/presentation"

const provenance = {
  source: { label: "Supplied expenses", url: null },
  asOf: "Supplied today",
}
const table: AnswerProps<"DataTable"> = {
  title: "Expenses",
  columns: [
    { key: "category", label: "Category" },
    { key: "amount", label: "Amount", format: "currency", currency: "EUR" },
  ],
  rows: [
    { category: "Food", amount: 0.1 },
    { category: "Food", amount: 0.2 },
    { category: "Travel", amount: 12 },
  ],
  ...provenance,
}
const stops = [
  { name: "Gallery", address: "Dublin", latitude: 53.3409, longitude: -6.2526 },
  { name: "Park", address: "Dublin", latitude: 53.3382, longitude: -6.2591 },
]

describe("composed answer tools", () => {
  it.each([
    { expression: "40 / 4", unit: "EUR", result: 10, computed: "arithmetic" },
    {
      expression: "350 F",
      unit: "C",
      result: 176.66666666667,
      computed: "conversion",
    },
  ])(
    "recomputes composed calculations instead of trusting model results: $expression",
    ({ expression, unit, result, computed }) => {
      const props = {
        title: "Result",
        expression,
        result: 999,
        unit,
        computed: "conversion" as const,
      }
      const spec = presentAnswerSpec({
        root: "answer",
        elements: { answer: { type: "Calculation", props, children: [] } },
      })
      expect(spec.elements.answer!.props).toMatchObject({ result, computed })
      const brief = createBrief({
        title: "Day",
        summary: "Proposed",
        date: "Today",
        cards: [
          { type: "Calculation", props },
          { type: "DataTable", props: table },
        ],
      })
      expect(brief.spec.elements.card0!.props).toMatchObject({
        result,
        computed,
      })
    }
  )
  it("rejects fabricated or unsupported expressions even with a claimed computation marker", () => {
    expect(() =>
      presentAnswerSpec({
        root: "answer",
        elements: {
          answer: {
            type: "Calculation",
            props: {
              title: "Bad",
              expression: "Math.random()",
              result: 10,
              unit: "EUR",
              computed: "arithmetic",
            },
            children: [],
          },
        },
      })
    ).toThrow()
  })
  it("round trips an editorial brief while retaining each card's source", () => {
    const brief = createBrief(
      briefInput.parse({
        title: "Your day",
        summary: "A proposed plan",
        date: "Today",
        cards: [
          { type: "DataTable", props: table },
          {
            type: "Calculation",
            props: {
              title: "Per person",
              expression: "12/4",
              result: 3,
              unit: "EUR",
            },
          },
        ],
      })
    )
    const spec = parseAnswerResult(JSON.stringify(brief))!
    expect(spec.elements.card0!.props.source).toEqual(provenance.source)
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(brief)} />
    )
    expect(html).toContain("Your day")
    expect(html).toContain("Supplied expenses")
    expect(html).toContain("Per person")
    expect(html).not.toContain("Couldn’t display")
    expect(() =>
      validateAnswerSpec({
        ...spec,
        elements: {
          ...spec.elements,
          brief: { ...spec.elements.brief!, children: ["card0"] },
        },
      })
    ).toThrow("two to eight")
  })
  it("rejects nested layout containers in a brief", () => {
    expect(() =>
      validateAnswerSpec({
        root: "brief",
        elements: {
          brief: {
            type: "Brief",
            props: { title: "Day", summary: "Plan", date: "Today" },
            children: ["stack", "table"],
          },
          stack: { type: "Stack", props: {}, children: [] },
          table: { type: "DataTable", props: table, children: [] },
        },
      })
    ).toThrow("answer cards")
  })
  it("calculates exact grouped sums, averages and counts from supplied rows", () => {
    const sums = analyzeData({
      table,
      groupBy: "category",
      valueKey: "amount",
      operation: "sum",
    })
    expect(sums.spec.elements.summary!.props.rows).toEqual([
      { label: "Food", value: 0.3 },
      { label: "Travel", value: 12 },
    ])
    expect(sums.spec.elements.chart!.props.unit).toBe("EUR")
    expect(sums.spec.elements.data!.props).toEqual(table)
    expect(
      analyzeData({
        table,
        groupBy: "category",
        valueKey: "amount",
        operation: "average",
      }).spec.elements.summary!.props.rows
    ).toEqual([
      { label: "Food", value: 0.15 },
      { label: "Travel", value: 12 },
    ])
    expect(
      analyzeData({
        table,
        groupBy: "category",
        valueKey: "",
        operation: "count",
      }).spec.elements.summary!.props.rows
    ).toEqual([
      { label: "Food", value: 2 },
      { label: "Travel", value: 1 },
    ])
  })
  it("keeps negative totals in a table and rejects missing or nonnumeric data", () => {
    const negative = { ...table, rows: [{ category: "Refund", amount: -5 }] }
    const answer = analyzeData({
      table: negative,
      groupBy: "category",
      valueKey: "amount",
      operation: "sum",
    })
    expect(answer.spec.elements.chart).toBeUndefined()
    expect(answer.spec.elements.summary!.props.rows).toEqual([
      { label: "Refund", value: -5 },
    ])
    expect(() =>
      analyzeData({
        table: { ...table, rows: [{ category: "Food", amount: null }] },
        groupBy: "category",
        valueKey: "amount",
        operation: "sum",
      })
    ).toThrow("finite numbers")
    expect(() =>
      analyzeData({
        table,
        groupBy: "missing",
        valueKey: "amount",
        operation: "sum",
      })
    ).toThrow("group column")
    expect(() =>
      analyzeData({
        table,
        groupBy: "category",
        valueKey: "missing",
        operation: "sum",
      })
    ).toThrow("numeric value column")
    expect(() =>
      analyzeData({
        table: {
          ...table,
          rows: Array.from({ length: 21 }, (_, i) => ({
            category: String(i),
            amount: 1,
          })),
        },
        groupBy: "category",
        valueKey: "amount",
        operation: "sum",
      })
    ).toThrow("twenty groups")
  })
  it("accepts bounded clarification choices and rejects duplicate choices", () => {
    const props = {
      question: "Which matters most?",
      description: "Choose your priorities",
      multiple: true,
      options: [
        { label: "Comfort", description: "All-day wear" },
        { label: "Price", description: "Within budget" },
      ],
    }
    expect(definitions.Question.props.parse(props)).toEqual(props)
    expect(() =>
      definitions.Question.props.parse({
        ...props,
        options: [props.options[0], props.options[0]],
      })
    ).toThrow("distinct options")
  })
  it("registers every presentation and lookup tool with access settings", () => {
    for (const name of [...richResultToolNames, "search_products"])
      expect(builtInTools.find((tool) => tool.name === name)?.mode, name).toBe(
        "allow"
      )
  })
})

describe("driving route adapter", () => {
  it("uses the fixed OSRM host, bounded options and supplied stop order", async () => {
    const coordinates = stops.map((stop) => [stop.longitude, stop.latitude])
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              distance: 2218.6,
              duration: 319.2,
              geometry: { type: "LineString", coordinates },
            },
          ],
        })
      )
    )
    const answer = await lookupRoute(
      { title: "Gallery to park", stops },
      undefined,
      request
    )
    const url = new URL(String(request.mock.calls[0]![0]))
    expect(url.origin).toBe("https://routing.openstreetmap.de")
    expect(url.pathname).toBe(
      "/routed-car/route/v1/driving/-6.2526,53.3409;-6.2591,53.3382"
    )
    expect(url.searchParams.get("overview")).toBe("simplified")
    expect(request.mock.calls[0]![1]).toMatchObject({
      redirect: "manual",
      signal: expect.any(AbortSignal),
      headers: {
        Accept: "application/json",
        "User-Agent": "DurablePi/1.0 (+https://bot.cill-i-am.com)",
        Referer: "https://bot.cill-i-am.com/",
      },
    })
    expect(answer.spec.elements.answer!.props).toMatchObject({
      coordinates,
      stops,
      profile: "driving",
      distanceMeters: 2218.6,
      durationSeconds: 319.2,
    })
  })
  it("rejects invalid coordinates and unbounded geometry", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "Ok",
          routes: [
            {
              distance: 2,
              duration: 1,
              geometry: {
                type: "LineString",
                coordinates: Array.from({ length: 1001 }, () => [-6, 53]),
              },
            },
          ],
        })
      )
    )
    await expect(
      lookupRoute(
        { title: "Day", stops: [{ ...stops[0]!, latitude: 91 }, stops[1]!] },
        undefined,
        request
      )
    ).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
    await expect(
      lookupRoute({ title: "Day", stops }, undefined, request)
    ).rejects.toThrow()
  })
})

describe("table filter semantics", () => {
  it("compares numeric values without silently coercing missing amounts to zero", () => {
    expect(matchesFilter(10, { operator: "gt", values: ["9"] })).toBe(true)
    expect(matchesFilter(10, { operator: "is", values: ["10.00"] })).toBe(true)
    expect(matchesFilter(null, { operator: "lt", values: ["1"] })).toBe(false)
    expect(matchesFilter("10", { operator: "gt", values: ["9"] })).toBe(false)
    expect(matchesFilter(10, { operator: "lt", values: ["bad"] })).toBe(false)
  })
  it("supports case-insensitive text and OR choices within a facet", () => {
    expect(
      matchesFilter("Food", { operator: "contains", values: ["foo"] })
    ).toBe(true)
    expect(
      matchesFilter("Travel", { operator: "in", values: ["Food", "Travel"] })
    ).toBe(true)
    expect(matchesFilter(false, { operator: "in", values: ["false"] })).toBe(
      true
    )
    expect(matchesFilter(null, { operator: "in", values: [""] })).toBe(true)
  })
})
