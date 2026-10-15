import { markReady } from "@/features/performance"
import { useCallback, useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { ModelSelection } from "@/conversations/turns"
import { ModelCatalog, ResolvedRoute, validateRoute } from "@/inference/policy"
import type { ModelSettings } from "@/inference/selection"
import { agentApi } from "@/http/client"

const Catalog = Schema.Struct({
  ...ModelCatalog.fields,
  selection: ModelSelection,
  assignments: Schema.Record(Schema.String, ResolvedRoute),
})
export function useModelCatalog(
  agentId: string,
  revision: number,
  onError: (message: string) => void
) {
  const requestSequence = useRef(0)
  const [catalog, setCatalog] = useState<typeof Catalog.Type | null>(null)
  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const next = Schema.decodeUnknownSync(Catalog)(
        await agentApi(agentId)("models")
      )
      if (sequence === requestSequence.current) {
        markReady("models")
        setCatalog((current) =>
          current &&
          current.selection.settingsRevision > next.selection.settingsRevision
            ? current
            : next
        )
      }
    } catch {
      if (sequence === requestSequence.current)
        onError("Could not verify model availability. Refresh to retry.")
    }
  }, [agentId, onError])
  useEffect(() => {
    void refresh()
    return () => {
      requestSequence.current++
    }
  }, [refresh, revision])
  function unavailable(value: ModelSettings) {
    if (!catalog) return "Checking account availability…"
    try {
      validateRoute(value, catalog)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : "Unavailable"
    }
  }
  return { catalog, refresh, unavailable, setCatalog, requestSequence }
}
