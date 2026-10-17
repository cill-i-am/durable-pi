import type { CredentialStore } from "@earendil-works/pi-ai"
import {
  createModels,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { Cause, Effect } from "effect"

import { runObserved } from "../../observability/worker"
import { fatalCause } from "../../shared/effect"
import { validateRoute, type ModelCatalog } from "../policy"
import type { ThinkingLevel } from "../selection"
import { workerChatGPTAuth } from "./credentials-pi"
import { memoryPayload } from "./payload-openai"
import { PiModelRequest } from "./streams-pi"
import { providerUsage } from "./usage-openai"
import type { NativeInferenceObservation } from "./usage-pi"

/** Usage persistence is part of the owned stream settlement. Expected failures
 * cross the SDK's untyped Promise interface without losing their complete Cause. */
async function persistUsage<T>(operation: () => T | Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (cause) {
    throw fatalCause(Cause.isCause(cause) ? cause : Cause.die(cause))
  }
}

export function createAgentModels(
  credentials: CredentialStore,
  options: {
    contextWindow?: (model: string) => number | undefined
    workingContextFloor?: () => number | undefined
    cacheKey?: string
    start: (request: PiModelRequest) => void
    catalog?: (signal?: AbortSignal) => Promise<ModelCatalog>
    beforeRequest?: (sessionId: string, signal?: AbortSignal) => Promise<void>
    onAttempt?: (
      model: string,
      thinking: ThinkingLevel,
      purpose: "conversation" | "compaction" | "memory",
      sessionId?: string
    ) => NativeInferenceObservation | Promise<NativeInferenceObservation>
    botId?: () => string
    waitUntil?: (work: Promise<unknown>) => void
  }
) {
  const sessions = new WeakMap<AbortSignal, PiModelRequest>()
  const models = createModels({
    credentials: {
      ...credentials,
      read: async (provider, request) => {
        const session = request?.signal
          ? sessions.get(request.signal)
          : undefined
        const read = () => credentials.read(provider, request)
        const credential = await (session ? session.callback(read) : read())
        if (credential && credential.type !== "oauth")
          throw new Error(
            "ChatGPT subscription required. API-key fallback is disabled."
          )
        return credential
      },
      modify: (provider, fn, request) => {
        const session = request?.signal
          ? sessions.get(request.signal)
          : undefined
        const modify = () => credentials.modify(provider, fn, request)
        return session ? session.callback(modify) : modify()
      },
      list: () => credentials.list(),
      delete: (provider) => credentials.delete(provider),
    },
    authContext: { env: async () => undefined, fileExists: async () => false },
  })
  const provider = openaiProvider()
  const configured: typeof provider = {
    ...provider,
    auth: { ...provider.auth, oauth: workerChatGPTAuth },
    getModels: () =>
      provider.getModels().map((model) => {
        const floor = options.workingContextFloor?.()
        const contextWindow = Math.min(
          model.contextWindow,
          options.contextWindow?.(model.id) ?? model.contextWindow,
          floor ?? model.contextWindow
        )
        return {
          ...model,
          contextWindow,
          maxTokens: model.maxTokens,
        }
      }),
    streamSimple(model, context, request) {
      const thinking = request?.reasoning ?? "off"
      const session = request?.signal ? sessions.get(request.signal) : undefined
      return provider.streamSimple(model, context, {
        ...request,
        maxRetries: 0,
        sessionId: options.cacheKey ?? request?.sessionId,
        cacheRetention: request?.cacheRetention ?? "short",
        onPayload: async (payload, selected) => {
          if (!getSupportedThinkingLevels(model).includes(thinking))
            throw new Error(
              "Unsupported reasoning effort. Select an available effort; automatic clamping is disabled."
            )
          const catalog = options.catalog
          if (catalog) {
            const capability = validateRoute(
              { model: model.id, thinking },
              await (session
                ? session.callback(() => catalog(request?.signal))
                : catalog(request?.signal)),
              context.messages.some(
                (m) =>
                  Array.isArray(m.content) &&
                  m.content.some((c) => c.type === "image")
              )
            )
            if (model.contextWindow > capability.contextWindow)
              throw new Error(
                "The account context budget changed. Start a new request with the verified model budget."
              )
          }
          request?.signal?.throwIfAborted()
          if (request?.sessionId) {
            const before = () =>
              options.beforeRequest?.(request.sessionId!, request.signal) ??
              Promise.resolve()
            await (session ? session.callback(before) : before())
          }
          request?.signal?.throwIfAborted()
          return memoryPayload(
            (await request?.onPayload?.(payload, selected)) ?? payload
          )
        },
      })
    },
  }
  models.setProvider(configured)
  const nativeStream = models.streamSimple.bind(models)
  models.streamSimple = (model, context, request) => {
    let observation: NativeInferenceObservation | undefined
    let incomplete = false
    const owned = new PiModelRequest(
      model,
      async (current) => {
        observation = await persistUsage(() =>
          options.onAttempt?.(
            model.id,
            request?.reasoning ?? "off",
            request?.sessionId === "memory"
              ? "memory"
              : request?.cacheRetention === "none"
                ? "compaction"
                : "conversation",
            request?.sessionId
          )
        )
        current.signal.throwIfAborted()
        const telemetry = runObserved(
          Effect.annotateCurrentSpan({
            "inference.model": model.id,
            "inference.purpose":
              request?.sessionId === "memory"
                ? "memory"
                : request?.cacheRetention === "none"
                  ? "compaction"
                  : "conversation",
            "inference.context_window": model.contextWindow,
            "inference.attempt_id": observation?.id ?? "unrecorded",
            "run.id": observation?.turnId ?? "",
            "bot.id": options.botId?.() ?? "",
          }).pipe(Effect.withSpan("Inference.dispatch"))
        ).catch(() => {})
        try {
          options.waitUntil?.(telemetry)
        } catch {}
        sessions.set(current.signal, current)
        void current.settled.then(() => sessions.delete(current.signal))
        return nativeStream(model, context, {
          ...request,
          signal: current.signal,
          fetch: (input, init) =>
            current.fetch(input, init, request?.fetch ?? globalThis.fetch),
          onPayload: (payload, selected) =>
            current.callback(
              async () =>
                (await request?.onPayload?.(payload, selected)) ?? payload
            ),
          onResponse: (response, selected) =>
            current.callback(async () => {
              await request?.onResponse?.(response, selected)
            }),
          onProviderStreamEvent: (event, selected) =>
            current.callback(async () => {
              const usage = providerUsage(event)
              if (usage) await persistUsage(() => observation?.usage(usage))
              if (
                typeof event === "object" &&
                event !== null &&
                "type" in event &&
                event.type === "response.incomplete"
              ) {
                incomplete = true
                throw new Error(
                  "OpenAI response incomplete. Partial output is not a completed request."
                )
              }
              await request?.onProviderStreamEvent?.(event, selected)
            }),
        })
      },
      async (event) => {
        if (event.type === "done") await observation?.end("completed")
        else
          await observation?.end(
            incomplete
              ? "incomplete"
              : event.reason === "aborted"
                ? "cancelled"
                : "failed",
            safeInferenceError(event.error.errorMessage ?? "")
          )
      },
      request?.signal
    )
    options.start(owned)
    try {
      options.waitUntil?.(owned.settled.then(() => undefined))
    } catch {}
    return owned.stream
  }
  return models
}

export function safeInferenceError(message: string) {
  if (/401|403|authoriz|authentic|credential/i.test(message))
    return "ChatGPT authorization failed. Reconnect the account."
  if (/429|rate.limit|usage.limit|subscription_sharing_usage/i.test(message))
    return "ChatGPT plan usage is currently limited. Wait for availability or check your plan usage."
  if (/incomplete/i.test(message))
    return "The provider returned an incomplete response."
  if (/interrupt|without.*stop|without.*complet/i.test(message))
    return "The provider stream ended before completion."
  if (/unavailable|unsupported|catalog|reasoning|discover/i.test(message))
    return "The selected model or effort could not be verified. Review model availability."
  return "The model request failed. Saved work remains available."
}
