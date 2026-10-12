import { useCallback, useMemo, useState } from "react"
import { useChat } from "@tanstack/ai-react"
import { Schema } from "effect"
import { ConversationMetadata } from "@/conversations/contracts"
import { conversationView } from "@/conversations/chat-messages"
import type { Submission } from "@/conversations/turns"
import { conversationConnection } from "./connection"

export function useConversation(agentId: string) {
  const [refresh, setRefresh] = useState(0)
  const id = `${agentId}:${refresh}`
  const connection = useMemo(() => conversationConnection(agentId), [agentId])
  const [metadata, setMetadata] = useState<{
    id: string
    value: typeof ConversationMetadata.Type
  } | null>(null)
  const [connectionError, setConnectionError] = useState({ id, value: "" })
  const chat = useChat({
    threadId: id,
    connection,
    live: true,
    // Pi owns queuing, approvals and execution. No client tools or auto-resume
    // submissions are registered; the live subscription is a read-only view.
    onCustomEvent(name, value) {
      if (name === "durable-pi.metadata")
        setMetadata({
          id,
          value: Schema.decodeUnknownSync(ConversationMetadata)(value),
        })
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
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  // Admission returns a durable receipt promptly. Do not wait for a model reply
  // or put pending messages into TanStack's browser-only queue.
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
