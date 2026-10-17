import { useChat } from "@tanstack/ai-react"
import { Schema } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"

import { conversationView } from "@/conversations/adapters/tanstack"
import { ConversationMetadata } from "@/conversations/contracts"
import type { Submission } from "@/conversations/turns"
import { markReady } from "@/features/performance"

import { conversationConnection } from "./connection"

export function useConversation(agentId: string, enabled = true) {
  const [refresh, setRefresh] = useState(0)
  const id = `${agentId}:${refresh}`
  const connection = useMemo(
    () => conversationConnection(agentId),
    // oxlint-disable-next-line react/exhaustive-deps -- A reconnect generation deliberately creates a fresh transport and cursor.
    [agentId, refresh]
  )
  const [metadata, setMetadata] = useState<{
    id: string
    value: typeof ConversationMetadata.Type
  } | null>(null)
  const [connectionError, setConnectionError] = useState({ id, value: "" })
  const chat = useChat({
    threadId: id,
    connection,
    live: enabled,
    onCustomEvent(name, value) {
      if (name === "durable-pi.metadata") {
        markReady("metadata")
        setMetadata({
          id,
          value: Schema.decodeUnknownSync(ConversationMetadata)(value),
        })
      }
      if (name === "durable-pi.connection" && typeof value === "string")
        setConnectionError({ id, value })
    },
  })
  const state = useMemo(
    () =>
      metadata?.id === id
        ? conversationView(chat.messages, metadata.value)
        : null,
    [chat.messages, metadata, id]
  )
  useEffect(() => {
    if (state) markReady("conversation")
  }, [state])
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  const submit = useCallback(
    (input: Submission) => connection.send([], input),
    [connection]
  )
  return {
    state,
    error:
      chat.error?.message ??
      (connectionError.id === id ? connectionError.value : ""),
    reload,
    submit,
  }
}
