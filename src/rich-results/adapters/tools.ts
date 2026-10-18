import { Type } from "@earendil-works/pi-ai"
import { defineTool } from "@earendil-works/pi-durable"
import { z } from "zod"

import { calculate, convertUnits, unitNames } from "../calculation"
import {
  answerResult,
  answerSpecSchema,
  definitions,
  type AnswerSpec,
  type AnswerProps,
} from "../catalog"
import {
  briefInput,
  createBrief,
  analysisInput,
  analyzeData,
  presentAnswerSpec,
} from "../presentation"
import { weatherRequestSchema, type WeatherRequest } from "../weather"
import { lookupPlaces, lookupWeather, lookupRoute } from "./lookups"

async function result(operation: () => unknown | Promise<unknown>) {
  try {
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(await operation()) },
      ],
    }
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Could not produce this result",
        },
      ],
    }
  }
}

// Derive the tool's component schemas from the same catalog used by the renderer.
const elementSchemas = Object.entries(definitions).map(
  ([type, definition]) => ({
    type: "object",
    additionalProperties: false,
    required: ["type", "props", "children"],
    properties: {
      type: {
        const: type,
        type: "string",
        description: definition.description,
      },
      props: z.toJSONSchema(definition.props),
      children: {
        type: "array",
        items: { type: "string" },
        maxItems: type === "Stack" ? 12 : type === "Brief" ? 8 : 0,
      },
    },
  })
)
const specSchema = z.toJSONSchema(answerSpecSchema)

export function richResultTools() {
  return [
    defineTool({
      name: "show_brief",
      description:
        "Compose two to eight distinct connected needs into a multi-part answer using sourced cards in an editorial layout. Use weather, places, timeline, calculation, products, comparisons, charts, tables or clarification cards. Embedded Calculation expressions are recomputed on the server, including canonical unit conversions such as '350 F' to unit 'C'; result is overwritten. A separate calculate call is unnecessary for an embedded calculation. Each card keeps its own source/date. Gather facts first; do not emit the same cards separately and again inside a brief. A single task needs its own card. Keep the brief summary interpretive, without replaying child data. Plans must be labelled proposed; this creates a saved answer, not a scheduled task.",
      parameters: Type.Unsafe<z.infer<typeof briefInput>>(
        z.toJSONSchema(briefInput)
      ),
      replay: "safe",
      execute: async (input) => result(() => createBrief(input)),
    }),
    defineTool({
      name: "ask_question",
      description:
        "Present one clarification question with two to seven choices and a free-text answer. Set multiple=true for independent priorities and false for mutually exclusive choices. Ask only when a missing choice blocks progress or the user requests choices; do not repeat options in prose. The user can add their answer to the composer and review it before sending. This does not pause a workflow, send a message or grant approval. Stop and wait for their reply before doing dependent work.",
      parameters: Type.Unsafe<AnswerProps<"Question">>(
        z.toJSONSchema(definitions.Question.props)
      ),
      replay: "safe",
      execute: async (input) => result(() => answerResult("Question", input)),
    }),
    defineTool({
      name: "compare_products",
      description:
        "Show researched product offers with a temporary shortlist, a spacious comparison workspace and a specification matrix. Research with search_products/browser tools first. Supply actual retailer URLs, price (null when unknown), one currency and source/date. Optional context captures the user's question and priorities. Use consistent spec labels and units for comparable facts while keeping conditions such as ANC on/off explicit. This card includes the comparison matrix: do not repeat its facts in a Markdown table, another DataTable or a prose list of every product. Follow it with a short recommendation and any necessary caveat. This tool only presents evidence; no search, checkout or purchase.",
      parameters: Type.Unsafe<AnswerProps<"Products">>(
        z.toJSONSchema(definitions.Products.props)
      ),
      replay: "safe",
      execute: async (input) => result(() => answerResult("Products", input)),
    }),
    defineTool({
      name: "analyze_data",
      description:
        "Present supplied tabular data with sorting, faceted filters and CSV export, and deterministically group rows by a column using sum, average or count. Supply valueKey for sum/average (empty for count). Use views to match the question: data for original rows, summary for a grouped table, chart for grouped bars. Choose only requested views; do not add source rows or a table to a chart-only request. Omit views for the legacy full analysis. Explicit chart requests require nonempty nonnegative totals; use summary for signed values. Max 200 rows/20 groups/28000 characters. No currency or unit conversion. Missing/nonnumeric amounts must be resolved first. The selected views are the answer; do not duplicate rows or chart values in prose, Markdown or another rich result. Add only a short interpretation.",
      parameters: Type.Unsafe<z.infer<typeof analysisInput>>(
        z.toJSONSchema(analysisInput)
      ),
      replay: "safe",
      execute: async (input) => result(() => analyzeData(input)),
    }),
    defineTool({
      name: "lookup_route",
      description:
        "Retrieve an OSRM driving route through two to eight sourced stops, with an interactive multi-pin map, route overlay, distance and duration estimate. Use sourced coordinates, resolving with lookup_places when needed. Preserve exactly the requested stop order; do not add sightseeing stops. The card already shows stops, distance and duration; do not repeat them as a prose itinerary. Coordinates are sent to OSRM's public service. Driving only; no walking, public transport or live traffic claims. No route optimization or bookings.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 200 }),
        stops: Type.Unsafe<AnswerProps<"Route">["stops"]>(
          z.toJSONSchema(definitions.Route.props.shape.stops)
        ),
      }),
      replay: "safe",
      execute: async (input, _api, execution) =>
        result(() => lookupRoute(input, execution.abortSignal)),
    }),
    defineTool({
      name: "show_ui",
      description:
        "Show interactive answers inline: shopping, comparison, rich tables, charts, timelines, weather, maps, routes, calculations or questions. DataTable is the default for tabular answers, including a simple request to make a table; keep numeric values numeric. Choose the smallest fitting card: Calculation for arithmetic, Places for locations, Route for a driving journey, Products for offers, Comparison for alternatives, Timeline for ordered events, BarChart for nonnegative magnitudes, Question for a necessary choice. Match requested counts and relevant criteria; do not pad a single task into a Brief or repeat a card in another table. Do not follow rich results with Markdown tables; add a short interpretation instead. Use Brief for an editorial multi-card layout, Stack for a simple group. Research current facts with browser/connected tools first, or use supplied data. Cite a real source and date; label proposed plans/example data. Never invent prices, availability, links or coordinates. This only presents data; no search, purchase, booking or external changes. Use a flat json-render spec {root, elements}; each element has type, props and children. Only Stack and Brief accept children. No actions, bindings, HTML or code. Max 28,000 characters/24 elements.",
      parameters: Type.Object({
        spec: Type.Unsafe<AnswerSpec>({
          ...specSchema,
          properties: {
            ...specSchema.properties,
            elements: {
              type: "object",
              additionalProperties: { oneOf: elementSchemas },
            },
          },
        }),
      }),
      replay: "safe",
      execute: async ({ spec }) =>
        result(() => ({
          kind: "rich-result",
          version: 1,
          spec: presentAnswerSpec(spec),
        })),
    }),
    defineTool({
      name: "lookup_places",
      description:
        "Look up an address, postcode, city or landmark using Photon/OpenStreetMap. Returns sourced candidates and selectable embedded maps. Include country/town for ambiguous queries; ask which candidate before relying on an ambiguous address. Query text is sent to Photon. No autocomplete, routing, opening-hours or booking claims.",
      parameters: Type.Object({
        query: Type.String({ minLength: 2, maxLength: 200 }),
      }),
      replay: "safe",
      execute: async ({ query }, _api, execution) =>
        result(() => lookupPlaces(query, execution.abortSignal)),
    }),
    defineTool({
      name: "lookup_weather",
      description:
        "Fetch a sourced forecast for the dates the user asked about. Use period today/tomorrow for one detailed day, period weekend for the upcoming Saturday and Sunday, or startDate plus days (1–16) for exact dates. Defaults to a seven-day overview. One or two days include hourly detail, feels-like temperatures, rain amounts, maximum wind/gusts and sunrise/sunset when available. The card adapts automatically: one detailed day, two comparison columns, or a compact longer outlook. Dates and relative periods use the location's timezone. Show this card instead of duplicating its metrics in a Markdown table; add only a short interpretation. Current conditions are separate from future forecasts. Use sourced coordinates (lookup_places), clarify ambiguous locations, and do not invent missing hours or dates beyond the forecast horizon. Coordinates are sent to Open-Meteo; snapshots are not subscriptions.",
      parameters: Type.Unsafe<WeatherRequest>(
        z.toJSONSchema(weatherRequestSchema)
      ),
      replay: "safe",
      execute: async (input, _api, execution) =>
        result(() => lookupWeather(input, execution.abortSignal)),
    }),
    defineTool({
      name: "calculate",
      description:
        "Calculate arithmetic deterministically and show an inline result. Supports numbers, parentheses, + - * / ^ and postfix % (20% means 0.2). No functions or variables. The card is the numerical answer: do not replay the expression and result in a prose walkthrough. Use show_brief/show_ui for different scenario calculations in one presentation. Good for discounts, split bills, recipe scaling and budget scenarios. Does not retrieve exchange rates or financial terms.",
      parameters: Type.Object({
        expression: Type.String({ minLength: 1, maxLength: 300 }),
        title: Type.String({ minLength: 1, maxLength: 200 }),
        unit: Type.String({ maxLength: 40 }),
      }),
      replay: "safe",
      execute: async ({ expression, title, unit }) =>
        result(() =>
          answerResult("Calculation", {
            title,
            expression,
            result: calculate(expression),
            unit,
            computed: "arithmetic",
          })
        ),
    }),
    defineTool({
      name: "convert_units",
      description: `Convert compatible measurements and show the result. Supported units: ${unitNames.join(", ")}. oz is mass, ml/l are volume. The card is the answer; add only a useful practical caveat, not repeated conversion steps. No ingredient density, currency, or ambiguous cups/gallons.`,
      parameters: Type.Object({
        value: Type.Number(),
        from: Type.String(),
        to: Type.String(),
      }),
      replay: "safe",
      execute: async ({ value, from, to }) =>
        result(() =>
          answerResult("Calculation", {
            title: `${from} to ${to}`,
            expression: `${value} ${from}`,
            result: convertUnits(value, from, to),
            unit: to,
            computed: "conversion",
          })
        ),
    }),
  ]
}
