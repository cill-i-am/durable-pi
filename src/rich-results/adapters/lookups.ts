import { z } from "zod"

import { answerResult, placeSchema, coordinateSchema } from "../catalog"
import {
  addWeatherDays,
  dateInTimezone,
  weatherRequestSchema,
  weatherWindow,
  type WeatherRequest,
  type WeatherDay,
} from "../weather"

async function readJson(
  url: URL,
  signal?: AbortSignal,
  request: typeof fetch = fetch
): Promise<unknown> {
  const response = await request(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
    headers: {
      Accept: "application/json",
      "User-Agent": "DurablePi/1.0 (+https://bot.cill-i-am.com)",
      Referer: "https://bot.cill-i-am.com/",
    },
    // Workers does not support "error"; the status check below rejects redirects.
    redirect: "manual",
  })
  if (!response.ok)
    throw new Error(
      `Lookup provider returned ${response.status}. Try again later.`
    )
  if (!response.body)
    throw new Error("Lookup provider returned an empty response")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      const chunk: unknown = next.value
      if (!(chunk instanceof Uint8Array))
        throw new Error("Lookup provider returned an invalid response stream")
      size += chunk.length
      if (size > 256_000)
        throw new Error("Lookup response exceeded the supported size")
      chunks.push(chunk)
    }
  } finally {
    await reader.cancel()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return JSON.parse(new TextDecoder().decode(bytes))
}

const photonSchema = z.object({
  features: z
    .array(
      z.object({
        geometry: z.object({ coordinates: z.tuple([z.number(), z.number()]) }),
        properties: z.object({
          name: z.string().optional(),
          street: z.string().optional(),
          housenumber: z.string().optional(),
          postcode: z.string().optional(),
          city: z.string().optional(),
          state: z.string().optional(),
          country: z.string().optional(),
        }),
      })
    )
    .max(20),
})

export async function lookupPlaces(
  query: string,
  signal?: AbortSignal,
  request?: typeof fetch
) {
  const clean = z.string().trim().min(2).max(200).parse(query)
  const url = new URL("https://photon.komoot.io/api/")
  url.search = new URLSearchParams({
    q: clean,
    limit: "5",
    lang: "en",
  }).toString()
  const data = photonSchema.parse(await readJson(url, signal, request))
  const places = data.features.map(({ geometry, properties: p }) =>
    placeSchema.parse({
      name: p.name || p.street || p.city || clean,
      address:
        [
          [p.housenumber, p.street].filter(Boolean).join(" "),
          p.postcode,
          p.city,
          p.state,
          p.country,
        ]
          .filter(Boolean)
          .join(", ") ||
        p.name ||
        clean,
      latitude: geometry.coordinates[1],
      longitude: geometry.coordinates[0],
    })
  )
  if (!places.length)
    throw new Error(
      "No places matched. Try adding a town, postcode or country."
    )
  return answerResult("Places", {
    title: clean,
    places,
    source: {
      label: "OpenStreetMap · Photon",
      url: "https://photon.komoot.io/",
    },
    asOf: new Date().toISOString(),
  })
}

export async function lookupRoute(
  input: { title: string; stops: z.infer<typeof placeSchema>[] },
  signal?: AbortSignal,
  request?: typeof fetch
) {
  const stops = z.array(placeSchema).min(2).max(8).parse(input.stops)
  const path = stops
    .map((stop) => `${stop.longitude},${stop.latitude}`)
    .join(";")
  const url = new URL(
    `https://routing.openstreetmap.de/routed-car/route/v1/driving/${path}`
  )
  url.search = new URLSearchParams({
    overview: "simplified",
    geometries: "geojson",
    steps: "false",
    alternatives: "false",
  }).toString()
  const data = z
    .object({
      code: z.string(),
      routes: z
        .array(
          z.object({
            distance: z.number().nonnegative(),
            duration: z.number().nonnegative(),
            geometry: z.object({
              type: z.literal("LineString"),
              coordinates: z.array(coordinateSchema).min(2).max(1000),
            }),
          })
        )
        .max(3),
    })
    .parse(await readJson(url, signal, request))
  const route = data.routes[0]
  if (data.code !== "Ok" || !route)
    throw new Error(
      "No driving route found between these stops. Try closer road-accessible locations."
    )
  return answerResult("Route", {
    title: input.title,
    stops,
    coordinates: route.geometry.coordinates,
    distanceMeters: route.distance,
    durationSeconds: route.duration,
    profile: "driving",
    source: {
      label: "OSRM · FOSSGIS · OpenStreetMap",
      url: "https://routing.openstreetmap.de/about.html",
    },
    asOf: new Date().toISOString(),
  })
}

const values = z.array(z.number().nullable())
const weatherSchema = z.object({
  timezone: z.string(),
  utc_offset_seconds: z.number(),
  current: z.object({
    temperature_2m: z.number(),
    apparent_temperature: z.number().nullable().optional(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    time: z.number(),
  }),
  daily: z.object({
    time: z.array(z.number()).min(1).max(16),
    temperature_2m_min: values,
    temperature_2m_max: values,
    precipitation_probability_max: values,
    weather_code: values,
    apparent_temperature_min: values.optional(),
    apparent_temperature_max: values.optional(),
    precipitation_sum: values.optional(),
    wind_speed_10m_max: values.optional(),
    wind_gusts_10m_max: values.optional(),
    uv_index_max: values.optional(),
    sunrise: values.optional(),
    sunset: values.optional(),
  }),
  hourly: z
    .object({
      time: z.array(z.number()).max(400),
      temperature_2m: values,
      weather_code: values,
      precipitation_probability: values.optional(),
      precipitation: values.optional(),
      wind_speed_10m: values.optional(),
    })
    .optional(),
})
type Forecast = z.infer<typeof weatherSchema>
const weatherValue = (series: (number | null)[] | undefined, index: number) =>
  series?.[index] ?? undefined
function requiredWeatherValue(series: (number | null)[], index: number) {
  const value = weatherValue(series, index)
  if (value === undefined)
    throw new Error(
      "Weather data is unavailable for a requested day. Try again later."
    )
  return value
}
const weatherInstant = (value: number | undefined) =>
  value === undefined ? undefined : new Date(value * 1000).toISOString()

function weatherHours(data: Forecast, date: string, now: Date) {
  if (!data.hourly) return undefined
  const hourly = data.hourly
  return hourly.time.flatMap((time, index) => {
    if (time < Math.floor(now.getTime() / 3_600_000) * 3600) return []
    if (dateInTimezone(new Date(time * 1000), data.timezone) !== date) return []
    const temperature = weatherValue(hourly.temperature_2m, index)
    const code = weatherValue(hourly.weather_code, index)
    if (temperature === undefined || code === undefined) return []
    return [
      {
        time: weatherInstant(time)!,
        temperature,
        condition: weatherCondition(code),
        rainPercent: weatherValue(hourly.precipitation_probability, index),
        rainMm: weatherValue(hourly.precipitation, index),
        windKph: weatherValue(hourly.wind_speed_10m, index),
      },
    ]
  })
}

function weatherDay(
  data: Forecast,
  index: number,
  date: string,
  detailed: boolean,
  now: Date
): WeatherDay {
  const daily = data.daily
  return {
    date,
    low: requiredWeatherValue(daily.temperature_2m_min, index),
    high: requiredWeatherValue(daily.temperature_2m_max, index),
    rainPercent: requiredWeatherValue(
      daily.precipitation_probability_max,
      index
    ),
    condition: weatherCondition(
      requiredWeatherValue(daily.weather_code, index)
    ),
    feelsLikeLow: weatherValue(daily.apparent_temperature_min, index),
    feelsLikeHigh: weatherValue(daily.apparent_temperature_max, index),
    rainMm: weatherValue(daily.precipitation_sum, index),
    windKph: weatherValue(daily.wind_speed_10m_max, index),
    gustKph: weatherValue(daily.wind_gusts_10m_max, index),
    uvIndex: weatherValue(daily.uv_index_max, index),
    sunrise: weatherInstant(weatherValue(daily.sunrise, index)),
    sunset: weatherInstant(weatherValue(daily.sunset, index)),
    hours: detailed ? weatherHours(data, date, now) : undefined,
  }
}

export function weatherCondition(code: number) {
  if (code === 0) return "Clear sky"
  if (code <= 3)
    return (
      ["Clear sky", "Mostly clear", "Partly cloudy", "Overcast"][code] ??
      "Cloudy"
    )
  if ([45, 48].includes(code)) return "Fog"
  if (code >= 51 && code <= 57) return "Drizzle"
  if (code >= 61 && code <= 67) return "Rain"
  if (code >= 71 && code <= 77) return "Snow"
  if (code >= 80 && code <= 82) return "Rain showers"
  if (code >= 85 && code <= 86) return "Snow showers"
  if (code >= 95) return "Thunderstorms"
  return "Conditions unavailable"
}
export async function lookupWeather(
  raw: WeatherRequest,
  signal?: AbortSignal,
  request?: typeof fetch,
  now = new Date()
) {
  const input = weatherRequestSchema.parse(raw)
  const count =
    input.days ?? (input.period === "weekend" ? 2 : input.period ? 1 : 7)
  const detailed = count <= 2
  // The provider uses one fixed UTC offset for all daily boundaries. Fetch a
  // margin for short forecasts so an IANA local day can still have 25 hours.
  // Explicit dates also need a day of margin because UTC's date can differ
  // from the location's date. Only the requested local dates are returned.
  const range = input.startDate
    ? Math.round(
        (Date.parse(`${input.startDate}T12:00:00Z`) -
          Date.parse(`${now.toISOString().slice(0, 10)}T12:00:00Z`)) /
          86_400_000
      ) +
      count +
      1
    : input.period === "weekend"
      ? 8
      : count + (input.period === "tomorrow" ? 1 : 0)
  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.search = new URLSearchParams({
    latitude: String(input.latitude),
    longitude: String(input.longitude),
    current: "temperature_2m,apparent_temperature,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,precipitation_sum,wind_speed_10m_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset",
    timezone: "auto",
    timeformat: "unixtime",
    temperature_unit: "celsius",
    wind_speed_unit: "kmh",
    precipitation_unit: "mm",
  }).toString()
  url.searchParams.set(
    "forecast_days",
    String(Math.max(1, Math.min(16, range + (detailed ? 1 : 0))))
  )
  if (detailed)
    url.searchParams.set(
      "hourly",
      "temperature_2m,weather_code,precipitation_probability,precipitation,wind_speed_10m"
    )
  const data = weatherSchema.parse(await readJson(url, signal, request))
  const today = dateInTimezone(now, data.timezone)
  const window = weatherWindow(input, today)
  const days = data.daily.time.flatMap((time, index) => {
    // Daily boundaries use the provider's fixed offset; hourly instants below
    // use the IANA timezone so clocks remain correct across a DST transition.
    const date = new Date((time + data.utc_offset_seconds) * 1000)
      .toISOString()
      .slice(0, 10)
    return date >= window.start && date <= window.end
      ? [weatherDay(data, index, date, detailed, now)]
      : []
  })
  if (
    days.length !== window.days ||
    days.some((day, index) => day.date !== addWeatherDays(window.start, index))
  )
    throw new Error(
      "The provider did not return every requested forecast date. Try a shorter or earlier range."
    )
  const currentDate = dateInTimezone(
    new Date(data.current.time * 1000),
    data.timezone
  )
  return answerResult("Weather", {
    location: input.location,
    timezone: data.timezone,
    days,
    current: days.some((day) => day.date === currentDate)
      ? {
          at: weatherInstant(data.current.time)!,
          temperature: data.current.temperature_2m,
          feelsLike: data.current.apparent_temperature ?? undefined,
          condition: weatherCondition(data.current.weather_code),
          windKph: data.current.wind_speed_10m,
        }
      : undefined,
    source: { label: "Open-Meteo", url: "https://open-meteo.com/" },
    asOf: now.toISOString(),
  })
}
