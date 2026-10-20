import { QueryClient } from "@tanstack/react-query"
import { afterEach, expect, test, vi } from "vitest"

import { modelQuery } from "../src/features/conversation/model-query"
import { newestModelCatalog } from "../src/inference/catalog-api"
import { catalog } from "./inference-fixture"

const response = {
  ...catalog,
  selection: {
    model: "gpt-6.1-sol",
    thinking: "medium" as const,
    settingsRevision: 1,
  },
  assignments: {},
}
afterEach(() => vi.unstubAllGlobals())

test("the Effect query shares one request, isolates agents and cancels its underlying fetch", async () => {
  const client = new QueryClient()
  let abort: AbortSignal | null | undefined
  let release!: (response: Response) => void
  const fetcher = vi.fn((_url: unknown, options?: RequestInit) => {
    abort = options?.signal
    return new Promise<Response>((resolve) => {
      release = resolve
    })
  })
  vi.stubGlobal("location", {
    origin: "https://app.example",
    pathname: "/agents",
  })
  vi.stubGlobal("fetch", fetcher)
  const options = modelQuery.queryOptions(
    { query: { agent: "one" } },
    { staleTime: 60_000, retry: false }
  )
  const first = client.fetchQuery(options)
  const second = client.fetchQuery(options)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
  release(Response.json(response))
  expect(await first).toEqual(response)
  expect(await second).toEqual(response)
  expect(await client.fetchQuery(options)).toEqual(response)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const other = modelQuery.queryOptions(
    { query: { agent: "two" } },
    { retry: false }
  )
  const work = client.fetchQuery(other).catch((error) => error)
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2))
  const signal = abort
  await client.cancelQueries({ queryKey: other.queryKey })
  expect(signal?.aborted).toBe(true)
  release(Response.json(response))
  await work
  expect(client.getQueryData(other.queryKey)).toBeUndefined()
  client.clear()
  expect(client.getQueryData(options.queryKey)).toBeUndefined()
})

test("new authorization errors replace cached availability even when settings are older", () => {
  const previous = {
    ...response,
    selection: { ...response.selection, settingsRevision: 3 },
  }
  const next = { ...response, models: [], error: "Reconnect ChatGPT" }
  const merged = newestModelCatalog(previous, next)
  expect(merged.error).toBe("Reconnect ChatGPT")
  expect(merged.models).toEqual([])
  expect(merged.selection.settingsRevision).toBe(3)
})
