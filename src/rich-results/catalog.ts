import { defineCatalog } from "@json-render/core"
import { schema } from "@json-render/react/schema"
import { z } from "zod"

import { weatherCurrentSchema, weatherDaySchema } from "./weather"

const text = z.string().min(1).max(500)
export const webUrl = z
  .url()
  .max(2000)
  .refine((value) => {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
  }, "Use an HTTPS URL without credentials")
const source = z
  .object({
    label: text,
    url: webUrl
      .nullable()
      .describe(
        "Null for user-provided data or a proposed plan without a public source"
      ),
  })
  .strict()
const provenance = {
  source,
  asOf: text.describe(
    "When the data was retrieved, or the supplied dataset's date"
  ),
}
export const placeSchema = z
  .object({
    name: text,
    address: text,
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
  })
  .strict()
export const coordinateSchema = z.tuple([
  z.number().min(-180).max(180),
  z.number().min(-90).max(90),
])
export const productSchema = z
  .object({
    id: z.string().min(1).max(80),
    name: text,
    merchant: text,
    price: z
      .number()
      .nonnegative()
      .nullable()
      .describe("Null when price is unverified"),
    currency: z.string().regex(/^[A-Z]{3}$/),
    url: webUrl,
    imageUrl: webUrl.optional(),
    detail: text,
    availability: text.describe("Verified stock information, or 'Not checked'"),
    specs: z.array(z.object({ label: text, value: text }).strict()).max(10),
  })
  .strict()
const cell = z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])
export const definitions = {
  Stack: {
    props: z.object({}).strict(),
    slots: ["default"],
    description:
      "A simple group of related answer cards. Use children only for distinct needs; do not repeat a dataset in several cards.",
  },
  Brief: {
    props: z
      .object({
        title: text,
        summary: text,
        date: text,
      })
      .strict(),
    slots: ["default"],
    description:
      "A multi-part answer for two to eight distinct connected needs. Use only relevant children, each with its own source. A single calculation, list or chart needs its own card, not a Brief. Summary interprets the plan without repeating child data. No scheduling or external actions.",
  },
  Question: {
    props: z
      .object({
        question: text,
        description: text,
        options: z
          .array(
            z
              .object({
                label: z.string().min(1).max(120),
                description: z.string().max(300),
              })
              .strict()
          )
          .min(2)
          .max(7)
          .refine(
            (items) =>
              new Set(items.map((item) => item.label)).size === items.length,
            "Use distinct options"
          ),
        multiple: z.boolean(),
      })
      .strict(),
    description:
      "One focused clarification with choices and a free-text answer. multiple=true for independent priorities; false for mutually exclusive options. Only ask if needed or requested; do not repeat options in prose or do dependent research before the reply. Choices add to the draft, never send or approve an action.",
  },
  Weather: {
    props: z
      .object({
        location: text,
        // Retain old saved results; new lookups separate current conditions from forecasts.
        temperature: z.number().optional(),
        condition: text.optional(),
        windKph: z.number().nonnegative().optional(),
        current: weatherCurrentSchema.optional(),
        timezone: text,
        days: z
          .array(weatherDaySchema)
          .min(1)
          .max(16)
          .refine(
            (days) =>
              days.every((day, i) => i === 0 || days[i - 1]!.date < day.date),
            "Forecast dates must be unique and in order"
          ),
        ...provenance,
      })
      .strict(),
    description:
      "A composable forecast for exact local dates, Celsius and km/h. One day shows detailed conditions and hourly data; two days compare side by side; longer ranges use a compact overview. Prefer lookup_weather with period, startDate and days. Current conditions are separate from future forecasts. Do not duplicate its metrics in a Markdown table.",
  },
  Calculation: {
    props: z
      .object({
        title: text,
        expression: text,
        result: z.number(),
        unit: z.string().max(40),
        explanation: text.optional(),
        computed: z
          .enum(["arithmetic", "conversion"])
          .optional()
          .describe(
            "Assigned by the server after recomputing the expression; absent on legacy saved cards."
          ),
      })
      .strict(),
    description:
      "One numerical answer or conversion with relevant assumptions in explanation. Do not repeat its arithmetic or result in a prose walkthrough. A numerical answer computed by the server. Use arithmetic with numbers, parentheses, + - * / ^ % (put units in unit), or a canonical measurement such as '350 F' with unit 'C' for conversion. show_brief and show_ui recompute result; do not invent unsupported expressions.",
  },
  Places: {
    props: z
      .object({
        title: text,
        places: z.array(placeSchema).min(1).max(8),
        ...provenance,
      })
      .strict(),
    description:
      "One address or a requested set of places with selectable embedded OpenStreetMap. Match the requested number; do not add unrelated alternatives. Use Route for a journey. Coordinates must be sourced. The card supplies addresses; do not list them again in prose.",
  },
  Route: {
    props: z
      .object({
        title: text,
        stops: z.array(placeSchema).min(2).max(8),
        coordinates: z.array(coordinateSchema).min(2).max(1000),
        distanceMeters: z.number().nonnegative(),
        durationSeconds: z.number().nonnegative(),
        profile: z.literal("driving"),
        ...provenance,
      })
      .strict(),
    description:
      "An ordered driving journey with the requested stops, map, distance and estimated duration. Prefer lookup_route. Do not add stops or repeat its itinerary/metrics in prose. Use Places for locations without a journey. No live traffic, walking estimates or navigation guarantees.",
  },
  Products: {
    props: z
      .object({
        title: text,
        context: z
          .object({ question: text, priorities: z.array(text).max(8) })
          .strict()
          .optional(),
        products: z
          .array(productSchema)
          .min(1)
          .max(12)
          .refine(
            (items) =>
              new Set(items.map((item) => item.id)).size === items.length,
            "Use unique product IDs"
          )
          .refine(
            (items) => new Set(items.map((item) => item.currency)).size === 1,
            "Use one currency per shopping result; do not silently convert prices"
          ),
        ...provenance,
      })
      .strict(),
    description:
      "One or more shoppable sourced offers, limited to the requested products and priority specifications, with budget filtering, price sorting, shortlist and comparison. Use browser/connected tools to research real prices and URLs first; this component does not search or buy. Its comparison matrix already presents the specifications: do not duplicate them in a Markdown table or DataTable.",
  },
  DataTable: {
    props: z
      .object({
        title: text,
        columns: z
          .array(
            z
              .object({
                key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
                label: text,
                format: z
                  .enum([
                    "text",
                    "number",
                    "currency",
                    "percent",
                    "date",
                    "badge",
                    "link",
                  ])
                  .optional(),
                currency: z
                  .string()
                  .regex(/^[A-Z]{3}$/)
                  .optional(),
              })
              .strict()
          )
          .min(1)
          .max(12)
          .refine(
            (items) =>
              new Set(items.map((item) => item.key)).size === items.length,
            "Use unique column keys"
          ),
        rows: z.array(z.record(z.string().max(40), cell)).max(200),
        ...provenance,
      })
      .strict(),
    description:
      "The default for tabular answers instead of Markdown tables, including a simple request to make a table. Searchable, sortable, paginated, with CSV download. Columns support text, number, currency (supply currency code), percent (fraction), date (ISO), badge and HTTPS link formats. Keep numbers numeric for sorting. Good for expenses, flights, stock, plans or any dataset. Rows use the column keys. Max 200 rows. Do not repeat an existing Products, Comparison or Weather card's data here.",
  },
  Comparison: {
    props: z
      .object({
        title: text,
        options: z.array(text).min(2).max(4),
        criteria: z
          .array(
            z
              .object({ label: text, values: z.array(text).min(2).max(4) })
              .strict()
          )
          .min(1)
          .max(12),
        verdict: text,
        ...provenance,
      })
      .strict()
      .refine(
        (props) =>
          props.criteria.every(
            (row) => row.values.length === props.options.length
          ),
        "Each criterion needs one value per option"
      ),
    description:
      "A decision matrix for two to four alternatives, with only relevant criteria and a reasoned verdict reflecting the user's priorities. Use Products for shoppable offers. This is already the comparison table; do not repeat its criteria/values in prose, Markdown or DataTable.",
  },
  BarChart: {
    props: z
      .object({
        title: text,
        unit: z.string().max(40),
        values: z
          .array(
            z.object({ label: text, value: z.number().nonnegative() }).strict()
          )
          .min(1)
          .max(20),
        ...provenance,
      })
      .strict(),
    description:
      "A magnitude comparison or ranking with exactly the requested nonnegative values and units. Use analyze_data for grouped calculations, selecting only chart when that is the request. Signed values need a DataTable. Do not add an unrequested table or list chart values in prose. Never invent measurements.",
  },
  Timeline: {
    props: z
      .object({
        title: text,
        events: z
          .array(z.object({ when: text, title: text, detail: text }).strict())
          .min(1)
          .max(20),
        ...provenance,
      })
      .strict(),
    description:
      "Chronological events, an itinerary or project milestones, limited to the requested scope and events. Label proposed plans; never claim bookings. Do not repeat the event schedule in prose or add a DataTable with the same events.",
  },
}

export const answerCatalog = defineCatalog(schema, {
  components: definitions,
  actions: {},
})
export type AnswerType = keyof typeof definitions
export type AnswerProps<T extends AnswerType> = z.infer<
  (typeof definitions)[T]["props"]
>

// Deliberately static: model JSON cannot install actions, scripts, bindings or arbitrary HTML.
export const answerSpecSchema = z
  .object({
    root: z.string().min(1).max(80),
    elements: z.record(
      z.string().min(1).max(80),
      z
        .object({
          type: z.enum(
            Object.keys(definitions) as [AnswerType, ...AnswerType[]]
          ),
          props: z.record(z.string(), z.unknown()),
          children: z.array(z.string().min(1).max(80)).max(12),
        })
        .strict()
    ),
  })
  .strict()
export type AnswerSpec = z.infer<typeof answerSpecSchema>

export function validateAnswerSpec(input: unknown): AnswerSpec {
  const spec = answerSpecSchema.parse(input)
  if (JSON.stringify(spec).length > 28_000)
    throw new Error(
      "Keep rich results below 28,000 characters. Split large datasets into separate results."
    )
  const keys = Object.keys(spec.elements)
  if (keys.length > 24) throw new Error("Use at most 24 elements")
  const visited = new Set<string>()
  const visit = (key: string, depth: number) => {
    if (visited.has(key) || depth > 4)
      throw new Error(
        "Use a tree with no cycles, shared children, or more than four levels"
      )
    const element = spec.elements[key]
    if (!element) throw new Error(`Missing element: ${key}`)
    visited.add(key)
    element.props = definitions[element.type].props.parse(element.props)
    if (!["Stack", "Brief"].includes(element.type) && element.children.length)
      throw new Error("Only Stack and Brief accept children")
    if (
      element.type === "Brief" &&
      (element.children.length < 2 || element.children.length > 8)
    )
      throw new Error("A brief needs two to eight cards")
    if (
      element.type === "Brief" &&
      element.children.some((child) =>
        ["Stack", "Brief"].includes(spec.elements[child]?.type ?? "")
      )
    )
      throw new Error("Brief children must be answer cards")
    for (const child of element.children) visit(child, depth + 1)
  }
  visit(spec.root, 1)
  if (visited.size !== keys.length)
    throw new Error("Every element must be reachable from the root")
  return spec
}

export function answerResult<T extends AnswerType>(
  type: T,
  props: AnswerProps<T>
) {
  return {
    kind: "rich-result" as const,
    version: 1 as const,
    spec: validateAnswerSpec({
      root: "answer",
      elements: { answer: { type, props, children: [] } },
    }),
  }
}

const answerEnvelopeSchema = z
  .object({
    kind: z.literal("rich-result"),
    version: z.literal(1),
    spec: answerSpecSchema,
  })
  .strict()

export function parseAnswerResult(output: string): AnswerSpec | null {
  if (output.length > 32_000) return null
  try {
    const envelope = answerEnvelopeSchema.parse(JSON.parse(output))
    return validateAnswerSpec(envelope.spec)
  } catch {
    return null
  }
}
