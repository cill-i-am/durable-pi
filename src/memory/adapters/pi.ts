import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { nativeOperation } from "../../shared/interop"
import type { AssistantMessage, Message } from "@earendil-works/pi-ai"
import { SummaryFailure, SummaryModel } from "../summary-model"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type SummaryJob,
} from "../domain"

const expected = Schema.decodeUnknownOption(
  Schema.Union([
    SummaryFailure,
    InvalidMemory,
    MemoryNotReady,
    MemoryStorageError,
  ])
)
const rejected = (cause: unknown, channel: "failure" | "rejection") => {
  const known = expected(cause)
  if (known._tag === "Some") return known.value
  if (
    channel === "failure" ||
    Schema.isSchemaError(cause) ||
    cause instanceof SyntaxError
  )
    throw cause
  return new SummaryFailure({ reason: "unavailable" })
}

/** Abort the native signal and join settlement before releasing the caller.
 * A synchronous declared rejection remains valid at this owned SDK callback. */
const nativeSummary = (
  start: (signal: AbortSignal) => Promise<AssistantMessage>
) =>
  Effect.suspend(() => {
    let failedAfterCancellation = false
    return nativeOperation((signal) => {
      let task: Promise<AssistantMessage>
      try {
        task = start(signal)
      } catch (cause) {
        const known = expected(cause)
        if (known._tag === "Some") return Promise.reject(known.value)
        throw cause
      }
      return task.catch((cause: unknown) => {
        failedAfterCancellation = signal.aborted && cause !== signal.reason
        throw cause
      })
    }, rejected).pipe(
      Effect.onExit((exit) =>
        failedAfterCancellation &&
        Exit.isFailure(exit) &&
        !Cause.hasDies(exit.cause)
          ? Effect.logError("Memory.nativeSummaryFailedAfterCancellation")
          : Effect.void
      )
    )
  })

export const piSummaryCompletion = (
  complete: (
    messages: Message[],
    signal: AbortSignal,
    job: SummaryJob
  ) => Promise<AssistantMessage>
) =>
  SummaryModel.of({
    complete: Effect.fn("Memory.Pi.complete")(function* (messages, job) {
      const nativeMessages = messages.map((message): Message =>
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
      )
      const reply = yield* nativeSummary((signal) =>
        complete(nativeMessages, signal, job)
      )
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

export const piSummaryLayer = (
  complete: Parameters<typeof piSummaryCompletion>[0]
) => Layer.succeed(SummaryModel, piSummaryCompletion(complete))
