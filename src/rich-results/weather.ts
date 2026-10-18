import { z } from "zod"

const localDate = z.iso.date()
const instant = z.iso.datetime()
const chance = z.number().min(0).max(100)
const nonnegative = z.number().nonnegative()

export const weatherHourSchema = z
  .object({
    time: instant,
    temperature: z.number(),
    condition: z.string().min(1).max(100),
    rainPercent: chance.optional(),
    rainMm: nonnegative.optional(),
    windKph: nonnegative.optional(),
  })
  .strict()

export const weatherDaySchema = z
  .object({
    date: localDate,
    low: z.number(),
    high: z.number(),
    rainPercent: chance,
    condition: z.string().min(1).max(500),
    feelsLikeLow: z.number().optional(),
    feelsLikeHigh: z.number().optional(),
    rainMm: nonnegative.optional(),
    windKph: nonnegative.optional(),
    gustKph: nonnegative.optional(),
    uvIndex: nonnegative.optional(),
    sunrise: instant.optional(),
    sunset: instant.optional(),
    // A local day can contain 25 hours when daylight saving time ends.
    hours: z.array(weatherHourSchema).max(25).optional(),
  })
  .strict()
  .refine((day) => day.low <= day.high, "The low must not exceed the high")

export const weatherCurrentSchema = z
  .object({
    at: instant,
    temperature: z.number(),
    feelsLike: z.number().optional(),
    condition: z.string().min(1).max(100),
    windKph: nonnegative,
  })
  .strict()

export const weatherRequestSchema = z
  .object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    location: z.string().min(1).max(200),
    period: z
      .enum(["today", "tomorrow", "weekend"])
      .optional()
      .describe(
        "Resolve relative dates in the location's timezone. Weekend means the upcoming Saturday and Sunday, including today if Saturday; on Sunday it means the following weekend."
      ),
    startDate: localDate
      .optional()
      .describe(
        "First local date, inclusive. Use this with days for specific dates; omit when using period."
      ),
    days: z
      .number()
      .int()
      .min(1)
      .max(16)
      .optional()
      .describe(
        "Number of days: 1 for a detailed day, 2 for comparison, or a longer overview. Defaults to 7, or 1 for today/tomorrow, or 2 for weekend."
      ),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.period && input.startDate)
      ctx.addIssue({
        code: "custom",
        message: "Choose period or startDate, not both",
      })
    if (
      input.period === "weekend" &&
      input.days !== undefined &&
      input.days !== 2
    )
      ctx.addIssue({
        code: "custom",
        message: "A weekend comparison needs two days",
      })
  })

export type WeatherRequest = z.infer<typeof weatherRequestSchema>
export type WeatherDay = z.infer<typeof weatherDaySchema>

export function dateInTimezone(time: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(time)
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value
  return `${part("year")}-${part("month")}-${part("day")}`
}

export function addWeatherDays(date: string, count: number) {
  const value = new Date(`${date}T12:00:00Z`)
  value.setUTCDate(value.getUTCDate() + count)
  return value.toISOString().slice(0, 10)
}

export function weatherWindow(input: WeatherRequest, today: string) {
  const days =
    input.days ?? (input.period === "weekend" ? 2 : input.period ? 1 : 7)
  let start = input.startDate ?? today
  if (input.period === "tomorrow") start = addWeatherDays(today, 1)
  if (input.period === "weekend") {
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay()
    start = addWeatherDays(today, (6 - weekday + 7) % 7)
  }
  const end = addWeatherDays(start, days - 1)
  if (start < today || end > addWeatherDays(today, 15))
    throw new Error(
      "Choose dates from today through the next 15 days. Later forecasts are not available yet."
    )
  return { start, end, days }
}
