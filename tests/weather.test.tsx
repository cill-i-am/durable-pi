import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import { weatherExamples } from "../src/features/rich-results/examples"
import { RichResult } from "../src/features/rich-results/rich-result"
import { lookupWeather } from "../src/rich-results/adapters/lookups"
import { answerResult, definitions } from "../src/rich-results/catalog"
import {
  addWeatherDays,
  dateInTimezone,
  weatherRequestSchema,
  weatherWindow,
} from "../src/rich-results/weather"

const location = { latitude: 53.34, longitude: -6.25, location: "Dublin" }
const now = new Date("2026-10-18T06:00:00Z")
const epoch = (time: string) => Date.parse(time) / 1000
function forecast() {
  return {
    timezone: "Europe/Dublin",
    utc_offset_seconds: 3600,
    current: {
      time: epoch(now.toISOString()),
      temperature_2m: 8,
      apparent_temperature: 6,
      weather_code: 2,
      wind_speed_10m: 7.2,
    },
    daily: {
      time: Array.from(
        { length: 16 },
        (_, index) =>
          epoch(`${addWeatherDays("2026-10-18", index)}T00:00:00Z`) - 3600
      ),
      temperature_2m_min: Array.from({ length: 16 }, () => 7),
      temperature_2m_max: Array.from({ length: 16 }, (_, index) =>
        index === 7 ? 17 : 12
      ),
      weather_code: Array.from({ length: 16 }, () => 51),
      precipitation_probability_max: Array.from({ length: 16 }, (_, index) =>
        index === 7 ? 55 : 57
      ),
      precipitation_sum: Array.from({ length: 16 }, () => 1.8),
      wind_speed_10m_max: Array.from({ length: 16 }, (_, index) =>
        index === 7 ? 24 : 31
      ),
      wind_gusts_10m_max: Array.from({ length: 16 }, () => 49),
      apparent_temperature_max: Array.from({ length: 16 }, () => 9),
      uv_index_max: Array.from({ length: 16 }, () => 1.2),
      sunrise: Array.from({ length: 16 }, (_, index) =>
        epoch(`${addWeatherDays("2026-10-18", index)}T07:10:00Z`)
      ),
      sunset: Array.from({ length: 16 }, (_, index) =>
        epoch(`${addWeatherDays("2026-10-18", index)}T17:15:00Z`)
      ),
    },
    hourly: {
      time: Array.from(
        { length: 25 },
        (_, index) => epoch("2026-10-24T23:00:00Z") + index * 3600
      ),
      temperature_2m: Array.from({ length: 25 }, () => 12),
      weather_code: Array.from({ length: 25 }, () => 2),
      precipitation_probability: Array.from({ length: 25 }, () => 20),
      precipitation: Array.from({ length: 25 }, () => 0.2),
      wind_speed_10m: Array.from({ length: 25 }, () => 18),
    },
  }
}
function provider(data: unknown = forecast()) {
  return vi
    .fn<typeof fetch>()
    .mockImplementation(async () => new Response(JSON.stringify(data)))
}

describe("weather dates and requested scope", () => {
  it.each([
    ["today", "2026-10-18", "2026-10-18", "2026-10-18"],
    ["tomorrow", "2026-10-18", "2026-10-19", "2026-10-19"],
    ["weekend", "2026-10-18", "2026-10-24", "2026-10-25"],
    ["weekend", "2026-10-17", "2026-10-17", "2026-10-18"],
  ] as const)("resolves %s relative to %s", (period, today, start, end) => {
    expect(weatherWindow({ ...location, period }, today)).toMatchObject({
      start,
      end,
    })
  })
  it("uses local dates rather than the execution host's date and crosses years", () => {
    expect(
      dateInTimezone(new Date("2026-10-17T23:30:00Z"), "Europe/Dublin")
    ).toBe("2026-10-18")
    expect(
      dateInTimezone(new Date("2026-10-17T23:30:00Z"), "America/Los_Angeles")
    ).toBe("2026-10-17")
    expect(
      weatherWindow(
        { ...location, startDate: "2026-12-31", days: 2 },
        "2026-12-30"
      )
    ).toEqual({ start: "2026-12-31", end: "2027-01-01", days: 2 })
  })
  it.each([
    { days: 0 },
    { days: 17 },
    { days: 1.5 },
    { startDate: "2026-02-30" },
    { startDate: "2026-10-24", period: "weekend" },
    { period: "weekend", days: 7 },
  ])("rejects an invalid or ambiguous request %j", (input) => {
    expect(
      weatherRequestSchema.safeParse({ ...location, ...input }).success
    ).toBe(false)
  })
  it("rejects dates outside the available forecast horizon", () => {
    expect(() =>
      weatherWindow({ ...location, startDate: "2026-10-17" }, "2026-10-18")
    ).toThrow("next 15 days")
    expect(() =>
      weatherWindow(
        { ...location, startDate: "2026-11-02", days: 2 },
        "2026-10-18"
      )
    ).toThrow("next 15 days")
  })
})

describe("weather provider and presentation", () => {
  it("returns exactly the requested weekend with daily wind, rain and no unrelated current temperature", async () => {
    const request = provider()
    const result = await lookupWeather(
      { ...location, period: "weekend" },
      undefined,
      request,
      now
    )
    const props = definitions.Weather.props.parse(
      result.spec.elements.answer!.props
    )
    expect(props.days.map((day) => day.date)).toEqual([
      "2026-10-24",
      "2026-10-25",
    ])
    expect(props.days.map((day) => day.windKph)).toEqual([31, 24])
    expect(props.days.map((day) => day.rainPercent)).toEqual([57, 55])
    expect(props.current).toBeUndefined()
    expect(props.asOf).toBe(now.toISOString())
    const query = new URL(String(request.mock.calls[0]![0]))
    expect(query.origin).toBe("https://api.open-meteo.com")
    expect(query.searchParams.get("timeformat")).toBe("unixtime")
    expect(query.searchParams.get("forecast_days")).toBe("9")
    expect(query.searchParams.get("hourly")).toContain(
      "precipitation_probability"
    )
    expect(request.mock.calls[0]![1]!.redirect).toBe("manual")
    expect(request.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal)
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(result)} />
    )
    expect(html).toContain('data-weather-layout="comparison"')
    expect(html).toMatch(/Saturday,? 24 October 2026/)
    expect(html).toMatch(/Sunday,? 25 October 2026/)
    expect(html).toContain("Maximum wind")
    expect(html).not.toContain("Current conditions")
  })
  it("requests an exact single day and preserves the 25 DST hours with distinct local clock labels", async () => {
    const request = provider()
    const result = await lookupWeather(
      { ...location, startDate: "2026-10-25", days: 1 },
      undefined,
      request,
      now
    )
    const props = definitions.Weather.props.parse(
      result.spec.elements.answer!.props
    )
    expect(props.days).toHaveLength(1)
    expect(props.days[0]!.hours).toHaveLength(25)
    const query = new URL(String(request.mock.calls[0]![0]))
    expect(query.searchParams.get("forecast_days")).toBe("10")
    expect(query.searchParams.has("start_date")).toBe(false)
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(result)} />
    )
    expect(html).toContain('data-weather-layout="day"')
    expect(html).toMatch(/Hourly forecast for Sunday,? 25 October 2026/)
    expect(html).toMatch(/01:00 (IST|GMT\+1)/)
    expect(html).toContain("01:00 GMT")
    expect(html).toContain("Gusts 49 km/h")
    expect(html).toContain("UV index")
  })
  it("keeps current observations separate and defaults to a compact seven-day overview without hourly data", async () => {
    const request = provider()
    const result = await lookupWeather(location, undefined, request, now)
    const props = definitions.Weather.props.parse(
      result.spec.elements.answer!.props
    )
    expect(props.days).toHaveLength(7)
    expect(props.current).toMatchObject({
      temperature: 8,
      feelsLike: 6,
      at: now.toISOString(),
    })
    expect(props.days.every((day) => day.hours === undefined)).toBe(true)
    const query = new URL(String(request.mock.calls[0]![0]))
    expect(query.searchParams.get("forecast_days")).toBe("7")
    expect(query.searchParams.has("hourly")).toBe(false)
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(result)} />
    )
    expect(html).toContain('data-weather-layout="overview"')
    expect(html).toContain("Current conditions")
    expect(html).not.toContain("Hourly forecast")
  })
  it("omits elapsed hours and missing optional readings without filling them in", async () => {
    const original = forecast()
    const data = {
      ...original,
      hourly: {
        ...original.hourly,
        time: [
          epoch("2026-10-18T05:00:00Z"),
          epoch("2026-10-18T06:00:00Z"),
          epoch("2026-10-18T07:00:00Z"),
        ],
        temperature_2m: [10, 11, null],
        precipitation_probability: [20, null, 20],
      },
      daily: { ...original.daily, precipitation_sum: [], uv_index_max: [] },
    }
    const result = await lookupWeather(
      { ...location, period: "today" },
      undefined,
      provider(data),
      new Date("2026-10-18T06:37:00Z")
    )
    const day = definitions.Weather.props.parse(
      result.spec.elements.answer!.props
    ).days[0]!
    expect(day.hours).toHaveLength(1)
    expect(day.hours![0]!.time).toBe("2026-10-18T06:00:00.000Z")
    expect(day.hours![0]!.rainPercent).toBeUndefined()
    expect(day.rainMm).toBeUndefined()
    expect(day.uvIndex).toBeUndefined()
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(result)} />
    )
    expect(html).not.toContain("mm precipitation")
    expect(html).not.toContain("UV index")
  })
  it("rejects incomplete dates and null daily measurements instead of inventing values", async () => {
    const data = forecast()
    data.daily.time = data.daily.time.slice(0, 1)
    await expect(
      lookupWeather({ ...location, days: 2 }, undefined, provider(data), now)
    ).rejects.toThrow("every requested")
    data.daily.temperature_2m_max = []
    await expect(
      lookupWeather({ ...location, days: 1 }, undefined, provider(data), now)
    ).rejects.toThrow("unavailable")
  })
  it("renders older saved weather cards and composes one-, two- and seven-day examples", () => {
    for (const example of weatherExamples) {
      const html = renderToStaticMarkup(<RichResult output={example.output} />)
      expect(html).not.toContain("Couldn’t display")
      expect(html).toContain("Illustrative sample data")
    }
    const result = answerResult("Weather", {
      location: "Dublin",
      temperature: 14,
      condition: "Overcast",
      windKph: 10,
      timezone: "Europe/Dublin",
      days: [
        {
          date: "2026-10-18",
          low: 8,
          high: 15,
          rainPercent: 30,
          condition: "Rain",
        },
      ],
      source: { label: "Old saved forecast", url: null },
      asOf: "18 October 2026",
    })
    const html = renderToStaticMarkup(
      <RichResult output={JSON.stringify(result)} />
    )
    expect(html).toContain("Old saved forecast")
    expect(html).toContain("Current conditions")
  })
})
