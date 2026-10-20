import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef } from "react"

import { markReady } from "@/features/performance"
import {
  newestModelCatalog,
  type ModelCatalogResponse,
} from "@/inference/catalog-api"
import { validateRoute } from "@/inference/policy"
import type { ModelSettings } from "@/inference/selection"

import { modelQuery } from "./model-query"

export function useModelCatalog(agentId: string, revision: number) {
  const client = useQueryClient()
  const input = useMemo(() => ({ query: { agent: agentId } }), [agentId])
  const key = useMemo(() => modelQuery.getQueryKey(input), [input])
  const query = useQuery(
    modelQuery.queryOptions(input, {
      staleTime: 60_000,
      gcTime: 300_000,
      refetchInterval: 60_000,
      retry: false,
      structuralSharing: (previous: unknown, next: unknown) =>
        newestModelCatalog(
          previous as ModelCatalogResponse | undefined,
          next as ModelCatalogResponse
        ),
    })
  )
  const previousRevision = useRef({ agentId, revision })
  useEffect(() => {
    const previous = previousRevision.current
    previousRevision.current = { agentId, revision }
    if (previous.agentId === agentId && previous.revision !== revision)
      void client.invalidateQueries({ queryKey: key })
  }, [agentId, revision, client, key])
  useEffect(() => {
    if (query.data) markReady("models")
  }, [query.data])
  const cancel = useCallback(
    () => client.cancelQueries({ queryKey: key }),
    [client, key]
  )
  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: key })
  }, [client, key])
  const setCatalog = useCallback(
    (
      update: (
        current: ModelCatalogResponse | null
      ) => ModelCatalogResponse | null
    ) => {
      client.setQueryData<ModelCatalogResponse>(
        key,
        (previous) => update(previous ?? null) ?? undefined
      )
    },
    [client, key]
  )
  // An authorization/transport error must not keep a stale "available" control enabled.
  const catalog = query.isError ? null : (query.data ?? null)
  function unavailable(value: ModelSettings) {
    if (!catalog)
      return query.isError
        ? "Could not verify model availability. Refresh to retry."
        : "Checking account availability…"
    try {
      validateRoute(value, catalog)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : "Unavailable"
    }
  }
  const catalogError = query.isError
    ? "Could not verify model availability. Refresh to retry."
    : (catalog?.error ?? "")
  return { catalog, catalogError, refresh, unavailable, setCatalog, cancel }
}
