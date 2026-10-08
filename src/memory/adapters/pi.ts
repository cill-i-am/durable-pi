import { Effect, Layer } from "effect"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { SummaryFailure, SummaryModel } from "../summary-model"

/** Pi owns authentication and provider transport; interruption reaches its AbortSignal. */
export const piSummaryLayer = (
  complete: (
    messages: Message[],
    signal: AbortSignal
  ) => Promise<AssistantMessage>
) =>
  Layer.succeed(
    SummaryModel,
    SummaryModel.of({
      complete: Effect.fn("Memory.Pi.complete")(function* (messages) {
        const reply = yield* Effect.tryPromise({
          try: (signal) =>
            complete(
              messages.map((message): Message =>
                message.role === "user"
                  ? {
                      role: "user",
                      content: message.text,
                      timestamp: 0,
                    }
                  : {
                      role: "assistant",
                      content: [{ type: "text", text: message.text }],
                      api: "openai-responses",
                      provider: "openai",
                      model: "summary",
                      usage: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                        totalTokens: 0,
                        cost: {
                          input: 0,
                          output: 0,
                          cacheRead: 0,
                          cacheWrite: 0,
                          total: 0,
                        },
                      },
                      stopReason: "stop",
                      timestamp: 0,
                    }
              ),
              signal
            ),
          // Provider errors may contain private prompts or credentials.
          catch: () => new SummaryFailure({ reason: "unavailable" }),
        })
        if (
          reply.stopReason === "error" ||
          reply.stopReason === "aborted" ||
          reply.content.some((part) => part.type === "toolCall")
        )
          return yield* new SummaryFailure({ reason: "unavailable" })
        return reply.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n")
      }),
    })
  )
