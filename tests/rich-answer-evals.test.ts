import { describe, expect, it } from "vitest"

import { cases } from "../evals/rich-answers/cases"
import { grade, readArchive } from "../evals/rich-answers/grade"
import { weatherExamples } from "../src/features/rich-results/examples"
import { answerResult } from "../src/rich-results/catalog"

const weekend = cases.find((test) => test.id === "weather-weekend")!
const weather = weatherExamples[1]!.result
type Row = { kind: "user" | "talk" | "tool" | "echo"; text: string }
function archive(rows: Row[]) {
  const until = { messages: rows.length, nodes: 0, notes: 0 }
  return [
    {
      type: "header",
      format: "durable-pi-memory",
      version: 1,
      until,
      parts: [],
    },
    ...rows.map((row, id) => ({
      type: "message",
      id,
      source: `fixture:${id}`,
      date: "2026-10-18T06:40:00.000Z",
      ...row,
    })),
    { type: "end", until },
  ]
    .map((row) => JSON.stringify(row))
    .join("\n")
}
const weatherRows = (): Row[] => [
  { kind: "user", text: weekend.prompt },
  {
    kind: "tool",
    text: JSON.stringify({
      name: "lookup_weather",
      arguments: {
        latitude: 53.34,
        longitude: -6.25,
        location: "Dublin",
        period: "weekend",
      },
    }),
  },
  { kind: "echo", text: JSON.stringify(weather) },
  {
    kind: "talk",
    text: "Sunday is warmer with lighter winds. Check the forecast again closer to the weekend.",
  },
]

describe("rich-answer eval graders (synthetic traces, not model runs)", () => {
  it("accepts a valid trace and records the evidence scope", () => {
    const result = grade(weekend, archive(weatherRows()), {
      failed: false,
      fallback: false,
      layout: "comparison",
      model: "test",
    })
    expect(result.pass).toBe(true)
    expect(result.evidence).toBe("live-ui-and-archive")
    const archiveOnly = grade(weekend, archive(weatherRows()))
    expect(archiveOnly.evidence).toBe("archive-only")
    expect(
      archiveOnly.checks.some((check) => check.name === "no-renderer-fallback")
    ).toBe(false)
  })
  it("fails when the model chose a week even if a later presentation hides the wrong scope", () => {
    const rows = weatherRows()
    rows[1]!.text = JSON.stringify({
      name: "lookup_weather",
      arguments: {
        latitude: 53.34,
        longitude: -6.25,
        location: "Dublin",
        days: 7,
      },
    })
    expect(grade(weekend, archive(rows)).checks).toContainEqual({
      name: "requested-forecast-scope",
      pass: false,
    })
  })
  it("accepts equivalent exact dates rather than requiring one parameter spelling", () => {
    const rows = weatherRows()
    rows[1]!.text = JSON.stringify({
      name: "lookup_weather",
      arguments: {
        latitude: 53.34,
        longitude: -6.25,
        location: "Dublin",
        startDate: "2026-10-24",
        days: 2,
      },
    })
    expect(grade(weekend, archive(rows)).pass).toBe(true)
  })
  it("scores an out-of-horizon request as a model failure rather than crashing the grader", () => {
    const rows = weatherRows()
    rows[1]!.text = JSON.stringify({
      name: "lookup_weather",
      arguments: {
        latitude: 53.34,
        longitude: -6.25,
        location: "Dublin",
        startDate: "2027-10-24",
        days: 2,
      },
    })
    expect(grade(weekend, archive(rows)).checks).toContainEqual({
      name: "requested-forecast-scope",
      pass: false,
    })
  })
  it("rejects the right dates for the wrong location", () => {
    const rows = weatherRows()
    rows[1]!.text = JSON.stringify({
      name: "lookup_weather",
      arguments: {
        latitude: 51.5,
        longitude: -0.1,
        location: "London",
        period: "weekend",
      },
    })
    expect(grade(weekend, archive(rows)).checks).toContainEqual({
      name: "dublin-forecast-location",
      pass: false,
    })
  })
  it("fails incorrect returned dates and duplicated Markdown tables", () => {
    const rows = weatherRows()
    rows[2]!.text = weatherExamples[2]!.output
    rows[3]!.text = "| Day | Rain |\n| --- | --- |\n| Saturday | 57% |"
    const result = grade(weekend, archive(rows))
    expect(result.checks).toContainEqual({
      name: "exact-forecast-dates",
      pass: false,
    })
    expect(result.checks).toContainEqual({
      name: "no-markdown-table",
      pass: false,
    })
    expect(result.pass).toBe(false)
  })
  it("fails missing tools, malformed arguments and invalid card schemas", () => {
    const rows = weatherRows()
    rows[1]!.text = JSON.stringify({
      name: "calculate",
      arguments: { expression: 42 },
    })
    rows[2]!.text = JSON.stringify({
      kind: "rich-result",
      version: 1,
      spec: { root: "missing", elements: {} },
    })
    const result = grade(weekend, archive(rows))
    expect(result.checks).toContainEqual({
      name: "valid-rich-tool-arguments",
      pass: false,
    })
    expect(result.checks).toContainEqual({
      name: "valid-card-schema",
      pass: false,
    })
    expect(result.checks).toContainEqual({
      name: "tool:lookup_weather",
      pass: false,
    })
  })
  it.each([
    "| Name | Hours |\n| --- | --- |\n| Ada | 12.5 |",
    "Name | Hours\n:--- | ---:\nAda | 12.5",
    "| Name |\n| --- |\n| Ada |",
    "Name | Hours\n- | -\nAda | 12.5",
    "```markdown\n| Name | Hours |\n| --- | --- |\n| Ada | 12.5 |\n```",
  ])(
    "rejects ordinary Markdown tables without needing a weather-specific flag: %s",
    (text) => {
      const test = cases.find((item) => item.id === "table-default")!
      const result = grade(
        test,
        archive([
          { kind: "user", text: test.prompt },
          { kind: "talk", text },
        ])
      )
      expect(result.checks).toContainEqual({
        name: "no-markdown-table",
        pass: false,
      })
      expect(result.checks).toContainEqual({
        name: "card:DataTable",
        pass: false,
      })
      expect(result.pass).toBe(false)
    }
  )
  it("requires the supplied rows and numeric hours in a rich table, with no duplicate Markdown recap", () => {
    const test = cases.find((item) => item.id === "table-default")!
    const result = answerResult("DataTable", {
      title: "Working hours",
      columns: [
        { key: "name", label: "Name" },
        { key: "team", label: "Team" },
        { key: "hours", label: "Hours", format: "number" },
      ],
      rows: [
        { name: "Ada", team: "Design", hours: 12.5 },
        { name: "Ben", team: "Engineering", hours: 8 },
        { name: "Cara", team: "Design", hours: 16 },
      ],
      source: { label: "Supplied records", url: null },
      asOf: "Supplied in this conversation",
    })
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "show_ui",
          arguments: { spec: result.spec },
        }),
      },
      { kind: "echo", text: JSON.stringify(result) },
    ]
    expect(grade(test, archive(rows)).pass).toBe(true)
    rows.push({
      kind: "talk",
      text: "| Name | Hours |\n| --- | --- |\n| Ada | 12.5 |",
    })
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "no-markdown-table",
      pass: false,
    })
    rows.pop()
    const table = result.spec.elements.answer!.props
    table.rows = [
      { name: "Ada", team: "Design", hours: "12.5 hours" },
      { name: "Ben", team: "Engineering", hours: 8 },
      { name: "Cara", team: "Design", hours: 16 },
    ]
    rows[2]!.text = JSON.stringify(result)
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "exact-supplied-records-with-numeric-hours",
      pass: false,
    })
  })
  it("allows explicit Markdown source requests without replacing them with a card", () => {
    const test = cases.find((item) => item.id === "markdown-source")!
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "talk",
        text: "```markdown\n| Name | Hours |\n| --- | --- |\n| Ada | 12 |\n| Ben | 8 |\n```",
      },
    ]
    expect(grade(test, archive(rows)).pass).toBe(true)
    rows[1]!.text = rows[1]!.text.replace("12", "13")
    expect(grade(test, archive(rows)).pass).toBe(false)
    rows[1]!.text = "| Name | Hours |\n| --- | --- |\n| Ada | 12 |\n| Ben | 8 |"
    expect(grade(test, archive(rows)).pass).toBe(false)
  })
  it("cannot borrow a correct result from an earlier or later request", () => {
    const rows = weatherRows()
    const old = rows.map((row) => ({ ...row }))
    old[0]!.text = "Earlier weather question"
    const after = rows.map((row) => ({ ...row }))
    after[0]!.text = "A later question"
    const result = grade(
      weekend,
      archive([
        ...old,
        { kind: "user", text: weekend.prompt },
        { kind: "talk", text: "I couldn't retrieve a forecast." },
        ...after,
      ])
    )
    expect(result.pass).toBe(false)
    expect(result.specs).toHaveLength(0)
  })
  it("rejects incomplete archives, wrong prompts and ambiguous repeated requests", () => {
    expect(() =>
      readArchive(archive(weatherRows()).split("\n").slice(0, -1).join("\n"))
    ).toThrow()
    expect(() =>
      grade({ ...weekend, prompt: "Different request" }, archive(weatherRows()))
    ).toThrow("exact eval request")
    expect(() =>
      grade(weekend, archive([...weatherRows(), ...weatherRows()]))
    ).toThrow("exact eval request")
  })
  it("treats UI failures as failures and preserves recovery diagnostics", () => {
    const result = grade(weekend, archive(weatherRows()), {
      failed: false,
      fallback: true,
      layout: "overview",
      staleClientReloads: 1,
    })
    expect(result.pass).toBe(false)
    expect(result.staleClientReloads).toBe(1)
    expect(result.checks).toContainEqual({
      name: "adaptive-weather-layout",
      pass: false,
    })
  })
  it("scores numerical correctness and unnecessary cards independently of prose", () => {
    const test = cases.find((item) => item.id === "split-bill")!
    const result = answerResult("Calculation", {
      title: "Share",
      expression: "186/4",
      result: 46.5,
      unit: "EUR",
    })
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "calculate",
          arguments: { title: "Share", expression: "186/4", unit: "EUR" },
        }),
      },
      { kind: "echo", text: JSON.stringify(result) },
      { kind: "talk", text: "Your share is €39.525." },
    ]
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "correct-calculation",
      pass: false,
    })
    const thanks = cases.find((item) => item.id === "thanks")!
    rows[0]!.text = thanks.prompt
    expect(grade(thanks, archive(rows)).checks).toContainEqual({
      name: "no-unnecessary-cards",
      pass: false,
    })
  })
  it("does not let one opened retailer verify unrelated product prices", () => {
    const test = cases.find((item) => item.id === "shopping")!
    const product = {
      id: "a",
      name: "Headphones",
      merchant: "Shop",
      price: 89,
      currency: "EUR",
      url: "https://example.com/product",
      detail: "Wireless",
      availability: "Not checked",
      specs: [],
    }
    const output = answerResult("Products", {
      title: "Offers",
      products: [
        product,
        { ...product, id: "b", url: "https://example.com/other" },
      ],
      source: { label: "Retailers", url: null },
      asOf: "Today",
    })
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "search_products",
          arguments: { query: "headphones", country: "ie" },
        }),
      },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "browser_open",
          arguments: { url: product.url },
        }),
      },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "compare_products",
          arguments: output.spec.elements.answer!.props,
        }),
      },
      { kind: "echo", text: JSON.stringify(output) },
      { kind: "talk", text: "Here are two offers." },
    ]
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "retailers-verified-before-comparison",
      pass: false,
    })
    const observation = (url: string): Row => ({
      kind: "echo",
      text: JSON.stringify({
        url,
        title: "Retailer product",
        text: "Public product details",
        links: [],
        capturedAt: 1792305900000,
      }),
    })
    const verified: Row[] = [
      ...rows.slice(0, 3),
      observation(product.url),
      {
        kind: "tool",
        text: JSON.stringify({
          name: "browser_interact",
          arguments: {
            generation: 0,
            version: 1,
            action: { kind: "click", x: 100, y: 100 },
          },
        }),
      },
      observation("https://example.com/other"),
      ...rows.slice(3),
    ]
    expect(grade(test, archive(verified)).checks).toContainEqual({
      name: "retailers-verified-before-comparison",
      pass: true,
    })
    // The two open/click requests alone are insufficient: require successful
    // browser observations of both exact product URLs before presentation.
    verified[5] = { kind: "echo", text: "Provider returned 403" }
    expect(grade(test, archive(verified)).checks).toContainEqual({
      name: "retailers-verified-before-comparison",
      pass: false,
    })
    rows[3]!.text = JSON.stringify({
      name: "show_ui",
      arguments: { spec: output.spec },
    })
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "retailers-verified-before-comparison",
      pass: false,
    })
  })
  it("requires server computation evidence even when a supplied number is correct", () => {
    const test = cases.find((item) => item.id === "split-bill")!
    const result = answerResult("Calculation", {
      title: "Share",
      expression: "186 * (1 - 15%) / 4",
      result: 39.525,
      unit: "EUR",
    })
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "calculate",
          arguments: {
            title: "Share",
            expression: "186 * (1 - 15%) / 4",
            unit: "EUR",
          },
        }),
      },
      { kind: "echo", text: JSON.stringify(result) },
    ]
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "server-computed-calculation",
      pass: false,
    })
    result.spec.elements.answer!.props.computed = "arithmetic"
    rows[2]!.text = JSON.stringify(result)
    expect(grade(test, archive(rows)).pass).toBe(true)
    result.spec.elements.answer!.props.result = 40
    rows[2]!.text = JSON.stringify(result)
    expect(grade(test, archive(rows)).checks).toContainEqual({
      name: "server-computed-calculation",
      pass: false,
    })
  })
  it("requires a complete shopping result with price and battery evidence for each product", () => {
    const test = cases.find((item) => item.id === "shopping")!
    const products = [89, 149].map((price, i) => ({
      id: String(i),
      name: `Headphones ${i}`,
      merchant: `Retailer ${i}`,
      price,
      currency: "EUR",
      url: `https://example.com/product-${i}`,
      detail: "Wireless ANC",
      availability: "Not checked",
      specs: [
        { label: "Battery life", value: i === 0 ? "30 hours" : "50 hours" },
      ],
    }))
    const result = answerResult("Products", {
      title: "Offers",
      products,
      source: { label: "Retailers", url: null },
      asOf: "Today",
    })
    const rows: Row[] = [
      { kind: "user", text: test.prompt },
      {
        kind: "tool",
        text: JSON.stringify({
          name: "search_products",
          arguments: { query: "ANC headphones", country: "ie" },
        }),
      },
      ...products.flatMap((product, i): Row[] => [
        {
          kind: "tool",
          text: JSON.stringify({
            name: "browser_open",
            arguments: { url: product.url },
          }),
        },
        {
          kind: "echo",
          text: JSON.stringify({
            url: product.url,
            title: product.name,
            text: `${product.name} €${i === 0 ? "89,00" : "149.00"}. Battery life: ${i === 0 ? 30 : 50} hours.`,
            links: [],
            capturedAt: 1792305900000,
          }),
        },
      ]),
      {
        kind: "tool",
        text: JSON.stringify({
          name: "compare_products",
          arguments: result.spec.elements.answer!.props,
        }),
      },
      { kind: "echo", text: JSON.stringify(result) },
    ]
    expect(grade(test, archive(rows)).pass).toBe(true)
    const duplicate = answerResult("DataTable", {
      title: "Same offers again",
      columns: [
        { key: "name", label: "Name" },
        { key: "price", label: "Price", format: "currency", currency: "EUR" },
      ],
      rows: products.map((product) => ({
        name: product.name,
        price: product.price,
      })),
      source: { label: "Retailers", url: null },
      asOf: "Today",
    })
    expect(
      grade(
        test,
        archive([...rows, { kind: "echo", text: JSON.stringify(duplicate) }])
      ).checks
    ).toContainEqual({
      name: "no-duplicate-product-table",
      pass: false,
    })
    expect(
      grade(
        test,
        archive([
          ...rows,
          {
            kind: "talk",
            text: "| Product | Price |\n| --- | --- |\n| Headphones 0 | €89 |",
          },
        ])
      ).checks
    ).toContainEqual({
      name: "no-markdown-table",
      pass: false,
    })
    const bad = [...rows]
    bad[3] = {
      kind: "echo",
      text: JSON.stringify({
        url: products[0]!.url,
        title: "Product",
        text: "€890. Battery life 35 hours.",
        links: [],
        capturedAt: 1792305900000,
      }),
    }
    expect(grade(test, archive(bad)).checks).toContainEqual({
      name: "retailer-price-and-battery-evidence",
      pass: false,
    })
    const unavailable: Row[] = [
      ...rows.slice(0, 2),
      { kind: "talk", text: "I cannot verify retailer offers right now." },
    ]
    expect(grade(test, archive(unavailable)).pass).toBe(false)
  })
  it("has unique case IDs and covers every rich tool plus negative controls", () => {
    expect(new Set(cases.map((test) => test.id)).size).toBe(cases.length)
    for (const tool of [
      "lookup_weather",
      "show_ui",
      "lookup_places",
      "lookup_route",
      "calculate",
      "convert_units",
      "analyze_data",
      "compare_products",
      "show_brief",
      "ask_question",
    ])
      expect(cases.some((test) => test.tools?.includes(tool))).toBe(true)
    expect(cases.filter((test) => test.noCards).length).toBeGreaterThanOrEqual(
      3
    )
  })
})
