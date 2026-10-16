import { sql, type SQLWrapper } from "drizzle-orm"

/** SQLite metadata and scalar expressions; complete statements use ORM builders. */
export const increment = (value: SQLWrapper, amount: number | SQLWrapper = 1) =>
  sql<number>`(${value} + ${amount})`
export const multiply = (value: SQLWrapper, amount: number | SQLWrapper) =>
  sql<number>`(${value} * ${amount})`
export const divide = (value: SQLWrapper, amount: number | SQLWrapper) =>
  sql<number>`(${value} / ${amount})`
export const remainder = (value: SQLWrapper, amount: number | SQLWrapper) =>
  sql<number>`(${value} % ${amount})`
export const coalesce = <T>(
  value: SQLWrapper | string | number | null,
  fallback: T | SQLWrapper
) => sql<T>`coalesce(${value}, ${fallback})`
export const jsonField = <T = unknown>(value: SQLWrapper, path: string) =>
  sql<T>`json_extract(${value}, ${path})`
export const literal = <T extends string | number | null>(value: T) =>
  sql<T>`${value}`
export const containsText = (value: SQLWrapper, text: string) =>
  sql<boolean>`instr(lower(${value}), lower(${text})) > 0`

export const concat = (...values: (SQLWrapper | string)[]) =>
  sql<string>`${sql.join(
    values.map((value) => sql`${value}`),
    sql` || `
  )}`
export const substring = (value: SQLWrapper, start: number, length: number) =>
  sql<string>`substr(${value}, ${start}, ${length})`
export const isoMillis = (value: SQLWrapper) =>
  sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ', ${value} / 1000.0, 'unixepoch')`
export const asText = (value: SQLWrapper) => sql<string>`cast(${value} as text)`
export const lower = (value: SQLWrapper | string) =>
  sql<string>`lower(${value})`
export const caseWhen = <T>(
  condition: SQLWrapper,
  yes: T | SQLWrapper,
  no: T | SQLWrapper
) => sql<T>`case when ${condition} then ${yes} else ${no} end`
export const jsonValid = (value: SQLWrapper) =>
  sql<boolean>`json_valid(${value})`
export const jsonObject = (
  fields: Record<string, SQLWrapper | string | number | null>
) =>
  sql<string>`json_object(${sql.join(
    Object.entries(fields).flatMap(([key, value]) => [
      sql`${key}`,
      sql`${value}`,
    ]),
    sql`, `
  )})`
