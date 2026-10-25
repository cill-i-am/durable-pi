import {
  fetchServerSentEvents,
  type SubscribeConnectionAdapter,
} from "@tanstack/ai-client"
import { Cause, Schema } from "effect"

import { SendInput } from "@/conversations/contracts"
import { api, agentUrl, ApiError } from "@/http/client"

import { markReady } from "../performance"
import { subscribeConversation } from "./connection-owner"
import {
  ownConversationResponse,
  closeConversationResponse,
} from "./connection-response"

export function conversationConnection(
  agentId: string
): SubscribeConnectionAdapter {
  return {
    subscribe(signal) {
      return subscribeConversation(
        async function* (cursor, owned) {
          let responseOwner:
            | ReturnType<typeof ownConversationResponse>
            | undefined
          let primary: unknown
          let denialCleanup: Cause.Cause<unknown> | undefined
          try {
            yield* fetchServerSentEvents(
              `${agentUrl(agentId, "events")}&protocol=tanstack`,
              {
                // Application cursor/retry ownership stays in the connection machine.
                reconnect: { maxAttempts: 0 },
                async fetchClient(input, init) {
                  const previous = responseOwner
                  responseOwner = undefined
                  await closeConversationResponse(previous)
                  const url = new URL(String(input), "https://app.internal")
                  if (cursor) url.searchParams.set("after", cursor)
                  const response = await fetch(url.pathname + url.search, init)
                  if ([401, 403, 404].includes(response.status)) {
                    const error = new ApiError(
                      response.status,
                      response.status === 401
                        ? "Your session has expired. Sign in again."
                        : "This agent is not available."
                    )
                    try {
                      await response.body?.cancel()
                    } catch (cause) {
                      // The SDK wraps fetch failures. Retain the authorization
                      // decision and native cleanup reasons across that boundary.
                      denialCleanup = Cause.combine(
                        Cause.fail(error),
                        Cause.isCause(cause) ? cause : Cause.die(cause)
                      )
                      throw denialCleanup
                    }
                    throw error
                  }
                  if (response.ok) markReady("stream-headers")
                  responseOwner = ownConversationResponse(response)
                  return responseOwner.response
                },
              }
            ).joinRun(agentId, owned)
          } catch (cause) {
            primary = denialCleanup ?? cause
            throw primary
          } finally {
            await closeConversationResponse(responseOwner, primary)
          }
        },
        signal,
        markReady
      )
    },
    async send(_messages, data, signal) {
      const input = Schema.decodeUnknownSync(SendInput)(data)
      await api(agentUrl(agentId, "send"), input, signal)
    },
  }
}
