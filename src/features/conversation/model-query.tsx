import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createTanstackQueryOptionsProxy } from "@tiesen/effect-tanstack-query"
import { Context, Layer, ManagedRuntime } from "effect"
import { FetchHttpClient } from "effect/http"
import { HttpApiClient } from "effect/http-api"
import { useEffect, useState, type ReactNode } from "react"

import { ModelQueryApi } from "@/inference/catalog-api"

class ModelClient extends Context.Service<
  ModelClient,
  HttpApiClient.ForApi<typeof ModelQueryApi>
>()("ModelClient") {}
// Stateless same-origin transport. No session data or query results live in this runtime.
const runtime = ManagedRuntime.make(
  Layer.effect(ModelClient, HttpApiClient.make(ModelQueryApi)).pipe(
    Layer.provide(FetchHttpClient.layer)
  )
)
export const modelQuery = createTanstackQueryOptionsProxy(ModelClient, runtime)
  .models.read

/** Mounted inside the authenticated family boundary; leaving it clears all results. */
export function ModelQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient())
  useEffect(() => () => client.clear(), [client])
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
