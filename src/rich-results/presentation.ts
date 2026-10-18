import { z } from "zod"

import { computeCalculation } from "./calculation"
import {
  definitions,
  validateAnswerSpec,
  type AnswerType,
  type AnswerProps,
} from "./catalog"

export function presentAnswerSpec(input: unknown) {
  const spec = validateAnswerSpec(input)
  return validateAnswerSpec({
    ...spec,
    elements: Object.fromEntries(
      Object.entries(spec.elements).map(([id, element]) => {
        if (element.type !== "Calculation") return [id, element]
        const props = definitions.Calculation.props.parse(element.props)
        return [
          id,
          {
            ...element,
            props: {
              ...props,
              ...computeCalculation(props.expression, props.unit),
            },
          },
        ]
      })
    ),
  })
}

function card<T extends Exclude<AnswerType, "Stack" | "Brief">>(type: T) {
  return z
    .object({ type: z.literal(type), props: definitions[type].props })
    .strict()
}
export const briefInput = definitions.Brief.props
  .extend({
    cards: z
      .array(
        z.discriminatedUnion("type", [
          card("Weather"),
          card("Calculation"),
          card("Places"),
          card("Products"),
          card("DataTable"),
          card("Comparison"),
          card("BarChart"),
          card("Timeline"),
          card("Question"),
          card("Route"),
        ])
      )
      .min(2)
      .max(8),
  })
  .strict()

export function createBrief(input: z.infer<typeof briefInput>) {
  const { cards: items, ...props } = briefInput.parse(input)
  return {
    kind: "rich-result" as const,
    version: 1 as const,
    spec: presentAnswerSpec({
      root: "brief",
      elements: {
        brief: {
          type: "Brief",
          props,
          children: items.map((_, i) => `card${i}`),
        },
        ...Object.fromEntries(
          items.map((item, i) => [
            `card${i}`,
            { type: item.type, props: item.props, children: [] },
          ])
        ),
      },
    }),
  }
}

export const analysisInput = z
  .object({
    table: definitions.DataTable.props,
    groupBy: z.string().min(1).max(40),
    valueKey: z.string().max(40),
    operation: z.enum(["sum", "average", "count"]),
    views: z
      .array(z.enum(["data", "summary", "chart"]))
      .min(1)
      .max(3)
      .refine(
        (views) => new Set(views).size === views.length,
        "Use unique views"
      )
      .optional()
      .describe(
        "Return only the views the question needs. data = original rows, summary = grouped table, chart = grouped bars. Omit for all available views."
      ),
  })
  .strict()

type DataColumn = AnswerProps<"DataTable">["columns"][number]

function aggregationFormat(
  operation: z.infer<typeof analysisInput>["operation"],
  valueColumn?: DataColumn
): { column: DataColumn; unit: string } {
  if (operation === "count")
    return {
      column: { key: "value", label: "Count", format: "number" },
      unit: "rows",
    }
  if (!valueColumn) throw new Error("Choose a numeric value column")
  return {
    column: { ...valueColumn, key: "value" },
    unit:
      valueColumn.currency ??
      (valueColumn.format === "percent" ? "fraction" : valueColumn.label),
  }
}

export function analyzeData(input: z.infer<typeof analysisInput>) {
  const { table, groupBy, valueKey, operation, views } =
    analysisInput.parse(input)
  const groupColumn = table.columns.find((column) => column.key === groupBy)
  if (!groupColumn) throw new Error("The group column is missing")
  const valueColumn = table.columns.find((column) => column.key === valueKey)
  const { column: summaryColumn, unit } = aggregationFormat(
    operation,
    valueColumn
  )
  const groups = new Map<string, { sum: number; count: number }>()
  for (const row of table.rows) {
    const key = String(row[groupBy] ?? "Not supplied")
    const group = groups.get(key) ?? { sum: 0, count: 0 }
    const value = operation === "count" ? 1 : row[valueKey]
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new Error(
        "All aggregated values must be finite numbers. Resolve missing or nonnumeric amounts first."
      )
    group.sum += value
    group.count++
    if (!Number.isFinite(group.sum))
      throw new Error("The total is outside the supported range")
    groups.set(key, group)
  }
  if (groups.size > 20)
    throw new Error("Use at most twenty groups for this summary")
  const values = [...groups].map(([label, group]) => ({
    label,
    value: Number(
      (operation === "average"
        ? group.sum / group.count
        : group.sum
      ).toPrecision(14)
    ),
  }))
  const labels = { sum: "Total", average: "Average", count: "Count" }
  const title = `${labels[operation]} by ${groupColumn.label}`
  const summary = {
    title,
    columns: [{ key: "label", label: groupColumn.label }, summaryColumn],
    rows: values,
    source: table.source,
    asOf: table.asOf,
  }
  const chart = values.length > 0 && values.every((item) => item.value >= 0)
  if (views?.includes("chart") && !chart)
    throw new Error(
      "Bar charts need nonempty, nonnegative totals. Request a summary table instead."
    )
  const selected = views ?? ["data", "summary", ...(chart ? ["chart"] : [])]
  return {
    kind: "rich-result" as const,
    version: 1 as const,
    spec: validateAnswerSpec({
      root: "analysis",
      elements: {
        analysis: {
          type: "Stack",
          props: {},
          children: selected,
        },
        ...(selected.includes("data")
          ? { data: { type: "DataTable", props: table, children: [] } }
          : {}),
        ...(selected.includes("summary")
          ? { summary: { type: "DataTable", props: summary, children: [] } }
          : {}),
        ...(selected.includes("chart")
          ? {
              chart: {
                type: "BarChart",
                props: {
                  title,
                  unit,
                  values,
                  ...{ source: table.source, asOf: table.asOf },
                },
                children: [],
              },
            }
          : {}),
      },
    }),
  }
}
