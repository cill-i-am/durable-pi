import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { activitySections } from "../src/features/conversation/activity-presentation"
import { cellText, tableCsv } from "../src/features/rich-results/data-table"
import { answerExamples } from "../src/features/rich-results/examples"
import { RichResult } from "../src/features/rich-results/rich-result"
import {
  lookupPlaces,
  lookupWeather,
} from "../src/rich-results/adapters/lookups"
import { richResultTools } from "../src/rich-results/adapters/tools"
import { calculate, convertUnits } from "../src/rich-results/calculation"
import {
  answerResult,
  definitions,
  parseAnswerResult,
  validateAnswerSpec,
} from "../src/rich-results/catalog"
import { richResultToolNames } from "../src/rich-results/contracts"

const calculation = () =>
  answerResult("Calculation", {
    title: "Split a bill",
    expression: "100 / 4",
    result: 25,
    unit: "EUR",
  })

describe("bounded json-render results", () => {
  it("round trips the persisted output and uses it in the chat timeline", () => {
    const output = JSON.stringify(calculation())
    expect(parseAnswerResult(output)).toEqual(calculation().spec)
    const item = {
      id: "tool-1",
      type: "tool" as const,
      name: "calculate",
      input: "{}",
      output,
      status: "done" as const,
    }
    expect(
      activitySections([
        item,
        { id: "answer", type: "text", text: "Your share." },
      ]).map((section) => section.type)
    ).toEqual(["work", "inline", "text"])
    expect(
      activitySections([{ ...item, status: "error" }]).map(
        (section) => section.type
      )
    ).toEqual(["work"])
    expect(
      activitySections([{ ...item, status: "running" }]).map(
        (section) => section.type
      )
    ).toEqual(["work"])
  })
  it("rejects unknown components, actions, dynamic expressions, cycles, dangling nodes and oversized results", () => {
    const base = calculation().spec
    for (const spec of [
      {
        ...base,
        elements: {
          answer: { type: "Html", props: { html: "<script/>" }, children: [] },
        },
      },
      {
        ...base,
        elements: {
          answer: {
            ...base.elements.answer,
            on: { press: { action: "purchase" } },
          },
        },
      },
      {
        ...base,
        elements: {
          answer: {
            ...base.elements.answer,
            props: {
              ...base.elements.answer!.props,
              result: { $state: "/value" },
            },
          },
        },
      },
      {
        root: "group",
        elements: { group: { type: "Stack", props: {}, children: ["group"] } },
      },
      { ...base, root: "missing" },
      { ...base, elements: { ...base.elements, orphan: base.elements.answer } },
      { ...base, state: { purchase: true } },
      { ...base, extra: "x".repeat(30_000) },
    ])
      expect(() => validateAnswerSpec(spec)).toThrow()
  })
  it("rejects dangerous links, invalid coordinates and mixed shopping currencies", () => {
    const product = answerExamples[0]!.result.spec.elements.answer!
    const props = product.props as { products: Record<string, unknown>[] }
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,test",
      "https://name:password@example.com/",
    ]) {
      expect(() =>
        validateAnswerSpec({
          root: "answer",
          elements: {
            answer: {
              ...product,
              props: {
                ...product.props,
                products: [{ ...props.products[0], url }],
              },
            },
          },
        })
      ).toThrow()
    }
    expect(() =>
      answerResult("Places", {
        title: "Invalid",
        places: [
          { name: "Invalid", address: "Invalid", latitude: 91, longitude: 0 },
        ],
        source: { label: "Test", url: "https://example.com" },
        asOf: "Today",
      })
    ).toThrow()
    expect(() =>
      validateAnswerSpec({
        root: "answer",
        elements: {
          answer: {
            ...product,
            props: {
              ...product.props,
              products: [
                props.products[0],
                { ...props.products[1], currency: "USD" },
              ],
            },
          },
        },
      })
    ).toThrow()
  })
  it("renders all examples and keeps malformed results recoverable", () => {
    for (const example of answerExamples) {
      const html = renderToStaticMarkup(<RichResult output={example.output} />)
      expect(html, example.id).not.toContain("Couldn’t display")
      expect(html, example.id).toContain('data-slot="card"')
    }
    expect(renderToStaticMarkup(<RichResult output="broken" />)).toContain(
      "recorded tool output"
    )
    expect(parseAnswerResult('{"kind":"other","version":1}')).toBeNull()
  })
  it("exports filtered rows as escaped CSV without spreadsheet formulas", () => {
    const csv = tableCsv(
      [
        { key: "name", label: "Name" },
        { key: "amount", label: "Amount" },
      ],
      [
        { name: '=HYPERLINK("https://bad.example")', amount: -2 },
        { name: 'A, "B"', amount: 5 },
      ]
    )
    expect(csv).toContain("'=")
    expect(csv).toContain('"-2"')
    expect(csv).toContain('"A, ""B"""')
    expect(csv.split("\r\n")).toHaveLength(3)
  })
  it("keeps a single offer focused and retains collection controls for multiple offers", () => {
    const example = answerExamples.find((item) => item.id === "shopping")!
    const props = definitions.Products.props.parse(
      example.result.spec.elements.answer!.props
    )
    const html = renderToStaticMarkup(
      <RichResult
        output={JSON.stringify(
          answerResult("Products", {
            ...props,
            products: props.products.slice(0, 1),
          })
        )}
      />
    )
    expect(html).toContain("Everyday wireless")
    expect(html).toContain("View retailer")
    expect(html).not.toContain("Search products")
    expect(html).not.toContain("Product view")
    expect(html).not.toContain("Shortlist")
    const collection = renderToStaticMarkup(
      <RichResult output={example.output} />
    )
    expect(collection).toContain("Search products")
    expect(collection).toContain("Product view")
  })
  it("shows an address directly for one place and selection controls for a map shortlist", () => {
    const example = answerExamples.find((item) => item.id === "places")!
    const props = definitions.Places.props.parse(
      example.result.spec.elements.answer!.props
    )
    const html = renderToStaticMarkup(
      <RichResult
        output={JSON.stringify(
          answerResult("Places", { ...props, places: props.places.slice(0, 1) })
        )}
      />
    )
    expect(html).toContain("<address")
    expect(html).toContain("Merrion Square West")
    expect(html).not.toContain("Select a place")
    expect(
      renderToStaticMarkup(<RichResult output={example.output} />)
    ).toContain('aria-label="Places"')
  })
  it("shows user-provided data without inventing a public source URL", () => {
    const output = JSON.stringify(
      answerResult("DataTable", {
        title: "My expenses",
        columns: [{ key: "amount", label: "Amount" }],
        rows: [{ amount: 15 }],
        source: { label: "User-provided expenses", url: null },
        asOf: "Supplied in this conversation",
      })
    )
    const html = renderToStaticMarkup(<RichResult output={output} />)
    expect(html).toContain("User-provided expenses")
    expect(html).not.toContain("Couldn’t display")
    expect(html).not.toContain('target="_blank"')
  })
  it("exposes tool schemas from the catalog", () => {
    const tools = richResultTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...richResultToolNames].sort()
    )
    const schema = JSON.stringify(
      tools.find((tool) => tool.name === "show_ui")!.parameters
    )
    expect(schema).toContain("Products")
    expect(schema).toContain("rainPercent")
  })
  it("formats typed cells without changing their underlying values", () => {
    expect(
      cellText(12.5, {
        key: "amount",
        label: "Amount",
        format: "currency",
        currency: "EUR",
      })
    ).toBe("€12.50")
    expect(
      cellText(0.15, { key: "discount", label: "Discount", format: "percent" })
    ).toBe("15%")
    expect(cellText(false, { key: "paid", label: "Paid" })).toBe("No")
    expect(
      cellText("not a date", { key: "date", label: "Date", format: "date" })
    ).toBe("not a date")
  })
})

describe("verified arithmetic and units", () => {
  it.each([
    ["186 * (1 - 15%) / 4", 39.525],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["2^-2", 0.25],
    ["3 × (4 + 2)", 18],
    ["1e3 / 4", 250],
    ["0.1 + 0.2", 0.3],
  ])("evaluates %s", (expression, value) =>
    expect(calculate(expression)).toBe(value)
  )
  it.each([
    "globalThis",
    "Math.random()",
    "1/0",
    "2(3)",
    "1 +",
    "1;2",
    "()",
    "9^9999",
    " ",
  ])("rejects %s", (expression) =>
    expect(() => calculate(expression)).toThrow()
  )
  it("converts compatible units, including temperature, without guessing density", () => {
    expect(convertUnits(10, "mi", "km")).toBe(16.09344)
    expect(convertUnits(32, "F", "C")).toBe(0)
    expect(convertUnits(250, "g", "kg")).toBe(0.25)
    expect(() => convertUnits(1, "g", "ml")).toThrow()
    expect(() => convertUnits(-274, "C", "F")).toThrow()
  })
})

describe("live lookup adapters", () => {
  it("requests fixed providers, preserves coordinates and returns source metadata", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          features: [
            {
              geometry: { coordinates: [-6.25, 53.34] },
              properties: {
                name: "Gallery",
                city: "Dublin",
                country: "Ireland",
              },
            },
          ],
        })
      )
    )
    const value = await lookupPlaces("Gallery Dublin", undefined, request)
    expect(value.spec.elements.answer!.props.places).toEqual([
      {
        name: "Gallery",
        address: "Dublin, Ireland",
        latitude: 53.34,
        longitude: -6.25,
      },
    ])
    expect(String(request.mock.calls[0]![0])).toMatch(
      /^https:\/\/photon.komoot.io\/api\//
    )
    expect(request.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
    expect(request.mock.calls[0]![1]!.redirect).toBe("manual")
    expect(value.spec.elements.answer!.props.source).toBeDefined()
  })
  it("maps weather into Celsius forecast cards and rejects incomplete days", async () => {
    const data = {
      timezone: "Europe/Dublin",
      utc_offset_seconds: 3600,
      current: {
        temperature_2m: 14,
        weather_code: 3,
        wind_speed_10m: 10,
        time: Date.parse("2026-10-17T11:00:00Z") / 1000,
      },
      daily: {
        time: [Date.parse("2026-10-16T23:00:00Z") / 1000],
        temperature_2m_min: [8],
        temperature_2m_max: [15],
        precipitation_probability_max: [30],
        weather_code: [61],
      },
    }
    const request = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => new Response(JSON.stringify(data)))
    const value = await lookupWeather(
      { latitude: 53.34, longitude: -6.25, location: "Dublin", days: 1 },
      undefined,
      request,
      new Date("2026-10-17T12:00:00Z")
    )
    expect(value.spec.elements.answer!.props.current).toMatchObject({
      condition: "Overcast",
      temperature: 14,
    })
    expect(request.mock.calls[0]![1]!.redirect).toBe("manual")
    expect(value.spec.elements.answer!.props.days).toEqual([
      {
        date: "2026-10-17",
        low: 8,
        high: 15,
        rainPercent: 30,
        condition: "Rain",
      },
    ])
    data.daily.temperature_2m_max = []
    await expect(
      lookupWeather(
        { latitude: 53.34, longitude: -6.25, location: "Dublin", days: 1 },
        undefined,
        request,
        new Date("2026-10-17T12:00:00Z")
      )
    ).rejects.toThrow()
  })
  it.each([301, 302, 303, 307, 308])(
    "rejects a provider redirect (%i) without following its location or reading its body",
    async (status) => {
      const response = new Response("not JSON", {
        status,
        headers: { Location: "https://other-provider.example/" },
      })
      const request = vi.fn<typeof fetch>().mockResolvedValue(response)
      await expect(
        lookupPlaces("County Kerry Ireland", undefined, request)
      ).rejects.toThrow(`Lookup provider returned ${status}`)
      expect(request).toHaveBeenCalledTimes(1)
      expect(request.mock.calls[0]![1]!.redirect).toBe("manual")
      expect(response.bodyUsed).toBe(false)
    }
  )
  it("fails clearly on no results, provider errors and unbounded responses", async () => {
    await expect(
      lookupPlaces(
        "Dublin",
        undefined,
        vi.fn<typeof fetch>().mockResolvedValue(new Response('{"features":[]}'))
      )
    ).rejects.toThrow("No places")
    await expect(
      lookupPlaces(
        "Dublin",
        undefined,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("", { status: 429 }))
      )
    ).rejects.toThrow("429")
    await expect(
      lookupPlaces(
        "Dublin",
        undefined,
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("x".repeat(256_001)))
      )
    ).rejects.toThrow("supported size")
  })
})
