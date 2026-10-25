import { validateToolCall } from "@earendil-works/pi-ai"
import { Effect, Schema } from "effect"
import { z } from "zod"

import { BrowserPage } from "../../src/browser/contracts"
import { parseArchive } from "../../src/memory/archive"
import { richResultTools } from "../../src/rich-results/adapters/tools"
import { computeCalculation } from "../../src/rich-results/calculation"
import {
  definitions,
  parseAnswerResult,
  type AnswerSpec,
} from "../../src/rich-results/catalog"
import {
  dateInTimezone,
  weatherWindow,
  weatherRequestSchema,
} from "../../src/rich-results/weather"
import { toolCall } from "../tool-call"
import { adaptiveDataChecks, cardChecks } from "./card-checks"
import type { EvalCase } from "./cases"

export const uiEvidence = z.object({
  failed: z.boolean(),
  fallback: z.boolean(),
  layout: z.string().optional(),
  model: z.string().optional(),
  staleClientReloads: z.number().int().nonnegative().optional(),
  failedTools: z.number().int().nonnegative().optional(),
  entryScript: z.string().optional(),
})
export type Check = { name: string; pass: boolean; detail?: string }

/** Read only complete, original-message exports; summary nodes are never evidence. */
export function readArchive(jsonl: string) {
  const { records } = Effect.runSync(parseArchive(jsonl))
  const messages = records.filter((row) => row.type === "message")
  if (
    new Set(messages.map((row) => row.id)).size !== messages.length ||
    messages.some((row, i) => i > 0 && row.id <= messages[i - 1]!.id)
  )
    throw new Error("Archive messages must be unique and ordered")
  return messages
}

export function grade(
  test: EvalCase,
  jsonl: string,
  ui?: z.infer<typeof uiEvidence>
) {
  const archive = readArchive(jsonl)
  const matches = archive.filter(
    (row) => row.kind === "user" && row.text === test.prompt
  )
  if (matches.length !== 1)
    throw new Error("The archive must contain this exact eval request once")
  const start = matches[0]!
  const next =
    archive.find((row) => row.kind === "user" && row.id > start.id)?.id ??
    Infinity
  const rows = archive.filter((row) => row.id > start.id && row.id < next)
  const calls = rows
    .filter((row) => row.kind === "tool")
    .map((row) => ({ ...toolCall.parse(JSON.parse(row.text)), at: row.id }))
  const text = rows
    .filter((row) => row.kind === "talk")
    .map((row) => row.text)
    .join("\n")
  const { specs, cards, invalid } = richSpecs(
    rows
      .filter((row) => row.kind === "echo")
      .map((row) => ({ text: row.text, at: row.id }))
  )
  const checks: Check[] = [
    {
      name: "completed-response",
      pass: rows.length > 0 && (text.trim().length > 0 || cards.length > 0),
    },
    { name: "valid-card-schema", pass: invalid === 0 },
  ]
  if (ui)
    checks.push(
      { name: "no-renderer-fallback", pass: !ui.fallback },
      { name: "no-failed-turn", pass: !ui.failed }
    )
  checks.push(...caseChecks(test, calls, cards, text))
  checks.push(...suppliedDataChecks(test.id, cards))
  checks.push(
    ...cardChecks(test, cards, text),
    ...adaptiveDataChecks(test.id, cards)
  )
  if (test.suppliedOnly)
    checks.push({
      name: "no-unrequested-research",
      pass: !calls.some((call) =>
        /^(lookup_|search_products$|browser_)/.test(call.name)
      ),
    })
  if (test.id === "calculation-scenarios")
    checks.push({
      name: "server-computed-calculation",
      pass: verifiedCalculations(cards),
    })
  if (test.weather)
    checks.push(...weatherChecks(test.weather, start.date, calls, cards, ui))
  if (test.research) checks.push(...shoppingChecks(rows, calls, cards))
  return {
    id: test.id,
    pass: checks.every((check) => check.pass),
    checks,
    calls,
    specs,
    text,
    model: ui?.model,
    evidence: ui ? "live-ui-and-archive" : "archive-only",
    staleClientReloads: ui?.staleClientReloads ?? 0,
    failedTools: ui?.failedTools,
    entryScript: ui?.entryScript,
    requestAt: start.date,
  }
}

type Call = z.infer<typeof toolCall> & { at: number }
type Card = AnswerSpec["elements"][string] & { at: number }
type UI = z.infer<typeof uiEvidence>

function weatherChecks(
  scope: NonNullable<EvalCase["weather"]>,
  requestAt: string,
  calls: Call[],
  cards: Card[],
  ui?: UI
): Check[] {
  const checks: Check[] = []
  const weather = cards
    .filter((card) => card.type === "Weather")
    .map((card) => definitions.Weather.props.parse(card.props))
  checks.push({
    name: "dublin-forecast-location",
    pass:
      weather.length > 0 &&
      weather.every(
        (card) =>
          /Dublin/i.test(card.location) && card.timezone === "Europe/Dublin"
      ) &&
      calls
        .filter((call) => call.name === "lookup_weather")
        .every((call) => {
          const input = weatherRequestSchema.safeParse(call.arguments)
          return (
            input.success &&
            input.data.latitude > 53.2 &&
            input.data.latitude < 53.5 &&
            input.data.longitude > -6.5 &&
            input.data.longitude < -6
          )
        }),
  })
  checks.push({
    name: "requested-forecast-scope",
    pass: calls
      .filter((call) => call.name === "lookup_weather")
      .every((call) => {
        const input = weatherRequestSchema.safeParse(call.arguments)
        if (!input.success) return false
        return weather.some((card) => {
          if (card.timezone !== "Europe/Dublin") return false
          const today = dateInTimezone(new Date(requestAt), card.timezone)
          const wanted = weatherWindow(
            {
              latitude: 53.34,
              longitude: -6.25,
              location: "Dublin",
              ...scope,
            },
            today
          )
          try {
            const requested = weatherWindow(input.data, today)
            return (
              requested.start === wanted.start && requested.end === wanted.end
            )
          } catch {
            return false
          }
        })
      }),
  })
  checks.push({
    name: "exact-forecast-dates",
    pass: weather.some((card) => {
      if (card.timezone !== "Europe/Dublin") return false
      const today = dateInTimezone(new Date(requestAt), card.timezone)
      const expected = weatherWindow(
        {
          latitude: 53.34,
          longitude: -6.25,
          location: "Dublin",
          ...scope,
        },
        today
      )
      return (
        card.days.length === expected.days &&
        card.days[0]!.date === expected.start &&
        card.days.at(-1)!.date === expected.end
      )
    }),
  })
  checks.push({
    name: "no-unrelated-current-observation",
    pass: weather.every(
      (card) =>
        card.timezone === "Europe/Dublin" &&
        (!card.current ||
          card.days.some(
            (day) =>
              day.date ===
              dateInTimezone(new Date(card.current!.at), card.timezone)
          ))
    ),
  })
  if (scope.days <= 2)
    checks.push({
      name: "hourly-detail-for-short-forecast",
      pass:
        weather.length > 0 &&
        weather.every((card) =>
          card.days.every(
            (day) => (day.hours?.length ?? 0) > 0 && day.windKph !== undefined
          )
        ),
    })
  const layout =
    scope.days === 1 ? "day" : scope.days === 2 ? "comparison" : "overview"
  if (ui)
    checks.push({
      name: "adaptive-weather-layout",
      pass: ui.layout === layout,
    })
  return checks
}

function shoppingChecks(
  rows: ReturnType<typeof readArchive>,
  calls: Call[],
  cards: Card[]
): Check[] {
  const checks: Check[] = []
  const products = cards
    .filter((card) => card.type === "Products")
    .flatMap((card) => {
      const presentation = [...calls]
        .reverse()
        .find(
          (call) =>
            call.at < card.at &&
            ["compare_products", "show_ui", "show_brief"].includes(call.name)
        )
      return definitions.Products.props
        .parse(card.props)
        .products.map((product) => ({
          ...product,
          before: presentation?.at ?? -1,
        }))
    })
  const observed = browserPages(rows, calls)
  checks.push({
    name: "retailers-verified-before-comparison",
    pass: products.every((product) =>
      observed.some(
        (page) => page.at < product.before && page.url === product.url
      )
    ),
  })
  checks.push({
    name: "two-priced-products-with-battery-specs",
    pass:
      products.length >= 2 &&
      products.every(
        (product) =>
          product.price !== null &&
          product.price > 0 &&
          product.price < 250 &&
          product.currency === "EUR" &&
          product.specs.some(
            (spec) =>
              /battery|playback|listening/i.test(spec.label) &&
              /\d/.test(spec.value)
          )
      ),
  })
  checks.push({
    name: "retailer-price-and-battery-evidence",
    pass:
      products.length >= 2 &&
      products.every((product) =>
        observed.some(
          (page) =>
            page.at < product.before &&
            page.url === product.url &&
            product.price !== null &&
            /€|EUR/.test(page.text) &&
            observedNumber(page.text, product.price) &&
            product.specs.some(
              (spec) =>
                /battery|playback|listening/i.test(spec.label) &&
                /battery|playback|listening/i.test(page.text) &&
                (spec.value.match(/\d+(?:\.\d+)?/g) ?? []).length > 0 &&
                (spec.value.match(/\d+(?:\.\d+)?/g) ?? []).every((value) =>
                  observedNumber(page.text, Number(value))
                )
            )
        )
      ),
  })
  return checks
}

function caseChecks(
  test: EvalCase,
  calls: Call[],
  cards: Card[],
  text: string
): Check[] {
  const checks: Check[] = []
  const definitionsForTools = richResultTools()
  checks.push({
    name: "valid-rich-tool-arguments",
    pass: calls.every((call) => {
      if (!definitionsForTools.some((tool) => tool.name === call.name))
        return true
      try {
        validateToolCall(definitionsForTools, {
          ...call,
          type: "toolCall",
          id: "eval",
        })
        return true
      } catch {
        return false
      }
    }),
  })
  for (const name of test.tools ?? [])
    checks.push({
      name: `tool:${name}`,
      pass: calls.some((call) => call.name === name),
    })
  for (const name of test.forbiddenTools ?? [])
    checks.push({
      name: `avoids:${name}`,
      pass: !calls.some((call) => call.name === name),
    })
  for (const type of test.cards ?? [])
    checks.push({
      name: `card:${type}`,
      pass: cards.some((card) => card.type === type),
    })
  if (test.noCards)
    checks.push({ name: "no-unnecessary-cards", pass: cards.length === 0 })
  if (test.clarify)
    checks.push({
      name: "clarifies-before-weather",
      pass:
        !calls.some((call) => call.name === "lookup_weather") &&
        (calls.some((call) => call.name === "ask_question") ||
          text.includes("?")),
    })
  checks.push(...presentationChecks(test, cards, text))
  if (test.result !== undefined) {
    checks.push({
      name: "correct-calculation",
      pass: cards.some(
        (card) =>
          card.type === "Calculation" &&
          Math.abs(
            definitions.Calculation.props.parse(card.props).result -
              test.result!
          ) < 1e-8
      ),
    })
    checks.push({
      name: "server-computed-calculation",
      pass: verifiedCalculations(cards),
    })
  }

  return checks
}

function verifiedCalculations(cards: Card[]) {
  const calculations = cards.filter((card) => card.type === "Calculation")
  return (
    calculations.length > 0 &&
    calculations.every((card) => {
      const props = definitions.Calculation.props.parse(card.props)
      try {
        const actual = computeCalculation(props.expression, props.unit)
        return (
          props.computed === actual.computed &&
          Math.abs(props.result - actual.result) < 1e-8
        )
      } catch {
        return false
      }
    })
  )
}

function presentationChecks(
  test: EvalCase,
  cards: Card[],
  text: string
): Check[] {
  const checks: Check[] = []
  if (test.markdownSource) {
    const source =
      /^(```|~~~)(?:markdown|md|text)?[ \t]*\r?\n([\s\S]*?)\r?\n\1$/i.exec(
        text.trim()
      )?.[2]
    checks.push({
      name: "requested-markdown-source",
      pass: source !== undefined && hasMarkdownTable(source),
    })
  } else
    checks.push({
      name: "no-markdown-table",
      pass: !hasMarkdownTable(text),
    })
  if (test.markdownSource && test.id === "markdown-source")
    checks.push({
      name: "exact-markdown-source-records",
      pass:
        /\bName\b/i.test(text) &&
        /\bHours\b/i.test(text) &&
        /^.*\bAda\b.*\|\s*12\s*\|?\s*$/m.test(text) &&
        /^.*\bBen\b.*\|\s*8\s*\|?\s*$/m.test(text),
    })
  if (test.cards?.includes("Products"))
    checks.push({
      name: "no-duplicate-product-table",
      pass:
        cards.filter((card) => card.type === "Products").length === 1 &&
        !cards.some(
          (card) => card.type === "DataTable" || card.type === "Comparison"
        ),
    })
  return checks
}

function hasMarkdownTable(text: string) {
  return /^[ \t]*.*\|.*\r?\n[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/m.test(
    text
  )
}

function richSpecs(outputs: { text: string; at: number }[]) {
  const specs: AnswerSpec[] = []
  const cards: Card[] = []
  let invalid = 0
  for (const { text, at } of outputs) {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      continue
    }
    if (
      value &&
      typeof value === "object" &&
      "kind" in value &&
      value.kind === "rich-result"
    ) {
      const spec = parseAnswerResult(text)
      if (spec) {
        specs.push(spec)
        cards.push(
          ...Object.values(spec.elements).map((card) => ({ ...card, at }))
        )
      } else invalid++
    }
  }
  return { specs, cards, invalid }
}

function suppliedDataChecks(id: string, cards: Card[]): Check[] {
  if (id === "table-default") {
    const tables = cards
      .filter((card) => card.type === "DataTable")
      .map((card) => definitions.DataTable.props.parse(card.props))
    return [
      {
        name: "exact-supplied-records-with-numeric-hours",
        pass: tables.some(
          (table) =>
            table.rows.length === 3 &&
            [
              ["Ada", "Design", 12.5],
              ["Ben", "Engineering", 8],
              ["Cara", "Design", 16],
            ].every((expected) =>
              table.rows.some((row) =>
                expected.every((value) => Object.values(row).includes(value))
              )
            )
        ),
      },
    ]
  }
  if (id === "products-supplied") {
    const products = cards
      .filter((card) => card.type === "Products")
      .flatMap((card) => definitions.Products.props.parse(card.props).products)
    return [
      {
        name: "exact-supplied-offers",
        pass:
          products.length === 2 &&
          products.some(
            (p) =>
              p.name === "Everyday wireless" &&
              p.price === 89 &&
              p.currency === "EUR" &&
              p.url === "https://example.com/everyday"
          ) &&
          products.some(
            (p) =>
              p.name === "Studio wireless" &&
              p.price === 149 &&
              p.currency === "EUR" &&
              p.url === "https://example.com/studio"
          ),
      },
      {
        name: "illustrative-pricing-labelled",
        pass: /illustrative/i.test(JSON.stringify(cards)),
      },
    ]
  }
  if (id === "expenses") {
    const charts = cards
      .filter((card) => card.type === "BarChart")
      .map((card) => definitions.BarChart.props.parse(card.props))
    return [
      {
        name: "exact-supplied-expense-rows",
        pass: cards
          .filter((card) => card.type === "DataTable")
          .some((card) => {
            const rows = definitions.DataTable.props.parse(card.props).rows
            return (
              rows.length === 3 &&
              [
                ["Food", 12.5],
                ["Travel", 5],
                ["Food", 7.5],
              ].every((expected) =>
                rows.some((row) =>
                  expected.every((value) => Object.values(row).includes(value))
                )
              )
            )
          }),
      },
      {
        name: "exact-chart-totals",
        pass: charts.some(
          (chart) =>
            chart.values.length === 2 &&
            chart.values.some((v) => v.label === "Food" && v.value === 20) &&
            chart.values.some((v) => v.label === "Travel" && v.value === 5)
        ),
      },
    ]
  }
  return []
}

function browserPages(rows: ReturnType<typeof readArchive>, calls: Call[]) {
  return rows.flatMap((row) => {
    if (row.kind !== "echo") return []
    const call = [...calls].reverse().find((call) => call.at < row.id)
    if (
      !call ||
      !["browser_open", "browser_read", "browser_interact"].includes(call.name)
    )
      return []
    try {
      const value: unknown = JSON.parse(row.text)
      return Schema.is(BrowserPage)(value)
        ? [{ at: row.id, url: value.url, text: value.text }]
        : []
    } catch {
      return []
    }
  })
}

function observedNumber(text: string, value: number) {
  const normalized = text.replace(/(\d)\s*[,.]\s*(?=\d)/g, "$1.")
  return [value.toFixed(2), String(value)].some((form) =>
    new RegExp(
      `(?:^|[^\\d.,])${form.replaceAll(".", "\\.")}(?!\\d|[.,]\\d)`
    ).test(normalized)
  )
}
