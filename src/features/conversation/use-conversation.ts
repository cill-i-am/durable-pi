import { useCallback, useEffect, useState } from "react"
import { Schema } from "effect"
import { ChatState, ConversationFrame } from "../../conversations/contracts"
import { api, agentUrl } from "../../http/client"
import { applyConversationFrame } from "./live-state"

export function useConversation(agentId: string) {
  const [refresh, setRefresh] = useState(0)
  const reload = useCallback(() => setRefresh((value) => value + 1), [])
  const [state, setState] = useState<ChatState | null>(null)
  const [error, setError] = useState("")
  useEffect(() => {
    const controller = new AbortController()
    const stream = new EventSource(agentUrl(agentId, "events"))
    let revision = 0
    let disconnected = true
    let polling = false
    let fallback: ReturnType<typeof setTimeout> | undefined
    // Event callbacks can change these flags while an HTTP fallback is awaiting.
    const canPoll = () => !controller.signal.aborted && disconnected
    const isCurrent = (version: number) => canPoll() && version === revision
    const scheduleFallback = (delay: number) => {
      if (canPoll() && !fallback && !polling) fallback = setTimeout(poll, delay)
    }
    const poll = async () => {
      fallback = undefined
      if (!canPoll() || polling) return
      polling = true
      const startedAt = revision
      try {
        const next = Schema.decodeUnknownSync(ChatState)(
          await api(agentUrl(agentId, "state"), undefined, controller.signal)
        )
        if (isCurrent(startedAt)) setState(next)
      } catch (cause) {
        if (isCurrent(startedAt))
          setError(
            cause instanceof Error ? cause.message : "Could not reconnect."
          )
      } finally {
        polling = false
        scheduleFallback(5000)
      }
    }
    stream.onmessage = (event) => {
      if (controller.signal.aborted) return
      try {
        const frame = Schema.decodeUnknownSync(ConversationFrame)(
          JSON.parse(event.data)
        )
        disconnected = false
        revision++
        setState((current) => applyConversationFrame(current, frame))
        setError("")
        clearTimeout(fallback)
        fallback = undefined
      } catch {
        setError("Could not read the update. Reconnect to try again.")
      }
    }
    stream.onerror = () => {
      if (controller.signal.aborted) return
      disconnected = true
      revision++
      setError("Connection interrupted. Reconnecting…")
      scheduleFallback(500)
    }
    return () => {
      controller.abort()
      stream.close()
      clearTimeout(fallback)
    }
  }, [agentId, refresh])
  return { state, error, reload }
}
