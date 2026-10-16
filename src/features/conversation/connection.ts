import { EventType, type StreamChunk } from "@tanstack/ai"
import {
  fetchServerSentEvents,
  type SubscribeConnectionAdapter,
} from "@tanstack/ai-client"
import { Schema } from "effect"

import { ConversationCursor, SendInput } from "@/conversations/contracts"
import { api, agentUrl, ApiError } from "@/http/client"

import { markReady } from "../performance"

export function conversationConnection(
  agentId: string
): SubscribeConnectionAdapter {
  let cursor: ConversationCursor | undefined
  const stream = fetchServerSentEvents(
    `${agentUrl(agentId, "events")}&protocol=tanstack`,
    {
      async fetchClient(input, init) {
        const url = new URL(String(input), "https://app.internal")
        if (cursor) url.searchParams.set("after", cursor)
        const response = await fetch(url.pathname + url.search, init)
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
        if (response.ok) markReady("stream-headers")
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
            if (chunk.type === EventType.MESSAGES_SNAPSHOT)
              markReady("snapshot")
            failures = 0
            if (!received)
              yield { type: "CUSTOM", name: "durable-pi.connection", value: "" }
            received = true
            const nextCursor = streamCursor(chunk)
            if (nextCursor) cursor = nextCursor
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

function streamCursor(chunk: StreamChunk): ConversationCursor | undefined {
  if (
    chunk.type !== "CUSTOM" ||
    chunk.name !== "durable-pi.cursor" ||
    typeof chunk.value !== "string"
  )
    return undefined
  const decoded = Schema.decodeUnknownOption(ConversationCursor)(chunk.value)
  return decoded._tag === "Some" ? decoded.value : undefined
}
