import { z } from "zod"

import { answerResult, placeSchema, coordinateSchema } from "../catalog"

async function readJson(
  url: URL,
  signal?: AbortSignal,
  request: typeof fetch = fetch
): Promise<unknown> {
  const response = await request(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12_000)])
      : AbortSignal.timeout(12_000),
    headers: { Accept: "application/json" },
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
    `https://router.project-osrm.org/route/v1/driving/${path}`
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
    source: { label: "OSRM · OpenStreetMap", url: "https://project-osrm.org/" },
    asOf: new Date().toISOString(),
  })
}

const weatherSchema = z.object({
  timezone: z.string(),
  current: z.object({
    temperature_2m: z.number(),
    weather_code: z.number(),
    wind_speed_10m: z.number(),
    time: z.string(),
  }),
  daily: z.object({
    time: z.array(z.string()).min(1).max(7),
    temperature_2m_min: z.array(z.number()),
    temperature_2m_max: z.array(z.number()),
    precipitation_probability_max: z.array(z.number()),
    weather_code: z.array(z.number()),
  }),
})
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
  input: { latitude: number; longitude: number; location: string },
  signal?: AbortSignal,
  request?: typeof fetch
) {
  const place = placeSchema.parse({
    latitude: input.latitude,
    longitude: input.longitude,
    name: input.location,
    address: input.location,
  })
  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.search = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,weather_code,wind_speed_10m",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "7",
  }).toString()
  const data = weatherSchema.parse(await readJson(url, signal, request))
  return answerResult("Weather", {
    location: input.location,
    temperature: data.current.temperature_2m,
    condition: weatherCondition(data.current.weather_code),
    windKph: data.current.wind_speed_10m,
    timezone: data.timezone,
    days: data.daily.time.map((date, index) => ({
      date,
      low: data.daily.temperature_2m_min[index]!,
      high: data.daily.temperature_2m_max[index]!,
      rainPercent: data.daily.precipitation_probability_max[index]!,
      condition: weatherCondition(data.daily.weather_code[index]!),
    })),
    source: { label: "Open-Meteo", url: "https://open-meteo.com/" },
    asOf: `${data.current.time} (${data.timezone})`,
  })
}
