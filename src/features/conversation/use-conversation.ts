import { useChat } from "@tanstack/ai-react"
import { Schema } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"

import { conversationView } from "@/conversations/adapters/tanstack"
import { ConversationMetadata, type ChatState } from "@/conversations/contracts"
import type { Submission } from "@/conversations/turns"
import { markReady } from "@/features/performance"
import { ApiError } from "@/http/client"

import { conversationConnection } from "./connection"

export function useConversation(agentId: string, enabled = true) {
  const [refresh, setRefresh] = useState(0)
  const id = `${agentId}:${enabled}:${refresh}`
  const connection = useMemo(
    () => conversationConnection(agentId),
    // oxlint-disable-next-line react/exhaustive-deps -- Reconnect and re-enable each require a fresh transport and cursor.
    [agentId, enabled, refresh]
  )
  const [metadata, setMetadata] = useState<{
    connection: typeof connection
    value: typeof ConversationMetadata.Type
  } | null>(null)
  const [connectionError, setConnectionError] = useState({
    connection,
    value: "",
  })
  const [streamError, setStreamError] = useState<{
    connection: typeof connection
    value: Error
  } | null>(null)
  const [retained, setRetained] = useState<{
    agentId: string
    enabled: boolean
    value: ChatState | null
  }>({ agentId, enabled, value: null })
  const chat = useChat({
    threadId: id,
    connection,
    live: enabled,
    onError(value) {
      setStreamError({ connection, value })
    },
    onCustomEvent(name, value) {
      if (name === "durable-pi.metadata") {
        markReady("metadata")
        setMetadata({
          connection,
          value: Schema.decodeUnknownSync(ConversationMetadata)(value),
        })
      }
      if (name === "durable-pi.connection" && typeof value === "string")
        setConnectionError({ connection, value })
    },
  })
  const current = useMemo(
    () =>
      metadata?.connection === connection
        ? conversationView(chat.messages, metadata.value)
        : null,
    [chat.messages, metadata, connection]
  )
  const failure =
    streamError?.connection === connection ? streamError.value : null
  const denied =
    failure instanceof ApiError && [401, 403, 404].includes(failure.status)
  const sameView = retained.agentId === agentId && retained.enabled === enabled
  // Initial messages precede metadata on a fresh stream. Keep the last complete
  // projection during that gap, so reconnect does not dispose recovery owners.
  // This is a view cache; only current-generation messages/metadata replace it.
  const state =
    !enabled || denied ? null : (current ?? (sameView ? retained.value : null))
  if (!sameView || retained.value !== state)
    setRetained({ agentId, enabled, value: state })
  useEffect(() => {
    if (state) markReady("conversation")
  }, [state])
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  const submit = useCallback(
    (input: Submission, signal?: AbortSignal) =>
      connection.send([], input, signal),
    [connection]
  )
  return {
    state,
    error:
      failure?.message ??
      (connectionError.connection === connection ? connectionError.value : ""),
    reload,
    submit,
  }
}
