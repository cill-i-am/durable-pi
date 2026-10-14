import {
  fetchServerSentEvents,
  type SubscribeConnectionAdapter,
} from "@tanstack/ai-client"
import { Schema } from "effect"
import { SendInput } from "@/conversations/contracts"
import { api, agentUrl, ApiError } from "@/http/client"

export function conversationConnection(
  agentId: string
): SubscribeConnectionAdapter {
  const stream = fetchServerSentEvents(
    `${agentUrl(agentId, "events")}&protocol=tanstack`,
    {
      async fetchClient(input, init) {
        const response = await fetch(input, init)
        if (
          response.status === 401 ||
          response.status === 403 ||
          response.status === 404
        )
          throw new ApiError(
            response.status,
            response.status === 401
              ? "Your session has expired. Sign in again."
              : "This agent is not available."
          )
        return response
      },
    }
  )
  return {
    async *subscribe(signal) {
      let failures = 0
      while (!signal?.aborted) {
        try {
          let received = false
          for await (const chunk of stream.joinRun(agentId, signal)) {
            if (signal?.aborted) return
            failures = 0
            if (!received)
              yield { type: "CUSTOM", name: "durable-pi.connection", value: "" }
            received = true
            yield chunk
          }
          if (!received && !signal?.aborted)
            throw new Error("Empty conversation stream")
        } catch (cause) {
          if (signal?.aborted) return
          const error =
            cause instanceof Error && cause.cause instanceof ApiError
              ? cause.cause
              : cause
          if (error instanceof ApiError) throw error
          if (++failures >= 5)
            throw new Error("Could not reconnect. Reconnect to try again.")
          yield {
            type: "CUSTOM",
            name: "durable-pi.connection",
            value: "Connection interrupted. Reconnecting…",
          }
        }
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer)
            signal?.removeEventListener("abort", finish)
            resolve()
          }
          const timer = setTimeout(finish, Math.min(250 * 2 ** failures, 4000))
          signal?.addEventListener("abort", finish, { once: true })
          if (signal?.aborted) finish()
        })
      }
    },
    async send(_messages, data, signal) {
      const input = Schema.decodeUnknownSync(SendInput)(data)
      await api(agentUrl(agentId, "send"), input, signal)
    },
  }
}
