import { Effect } from "effect"
import { runObserved } from "../observability/worker"
import { OperationalLogger } from "../observability/logger"
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream"
import { validateRoute, type ModelCatalog } from "../inference/policy"
import type { ThinkingLevel } from "../inference/selection"
import type { InferenceUsage } from "../inference/usage"
import {
  createModels,
  getSupportedThinkingLevels,
} from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import type {
  Credential,
  CredentialStore,
  OAuthAuth,
} from "@earendil-works/pi-ai"
import * as Schema from "effect/Schema"
import type { Sqlite } from "../storage/sqlite"
import { cacheUsage, memoryPayload, type CacheUsage } from "./cache"

const OAuthCredentialSchema = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.String,
  refresh: Schema.String,
  expires: Schema.Number,
  clientId: Schema.String,
})
const ApiCredentialSchema = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.String,
})
const CredentialSchema = Schema.Union([
  OAuthCredentialSchema,
  ApiCredentialSchema,
])
const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.String,
  expires_in: Schema.Number,
  scope: Schema.String,
})
export const decodeCredential = Schema.decodeUnknownSync(CredentialSchema)

/** Pi's login flow owns a Node callback server. Only its refresh protocol runs in workerd. */
export const workerChatGPTAuth: OAuthAuth = {
  name: "Sign in with ChatGPT",
  isSubscription: true,
  login: async () => {
    throw new Error("Run pnpm model:login on your own computer")
  },
  toAuth: async (credential) => ({ apiKey: credential.access }),
  refresh: async (credential, signal) => {
    if (typeof credential.clientId !== "string")
      throw new Error("Reconnect ChatGPT")
    const response = await fetch(
      "https://auth.openai.com/api/accounts/oauth/token",
      {
        method: "POST",
        signal,
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: credential.clientId,
          refresh_token: credential.refresh,
          resource: "https://api.openai.com/v1",
        }),
      }
    )
    if (!response.ok)
      throw new Error(
        "ChatGPT authorization expired. Reconnect with pnpm model:login."
      )
    const data = Schema.decodeUnknownSync(TokenResponse)(await response.json())
    if (
      !data.scope.split(/\s+/).includes("chatgpt.tokens.use.direct") ||
      data.expires_in <= 0
    )
      throw new Error("ChatGPT grant does not permit model requests")
    return {
      ...credential,
      access: data.access_token,
      refresh: data.refresh_token,
      expires: Date.now() + data.expires_in * 1000 - 180_000,
    }
  },
}

export class DurableCredentials implements CredentialStore {
  private lock = Promise.resolve()
  constructor(
    readonly db: Sqlite,
    readonly seed: string
  ) {
    db.run(
      "CREATE TABLE IF NOT EXISTS model_credentials (provider TEXT PRIMARY KEY, value TEXT NOT NULL, seed TEXT NOT NULL)"
    )
  }
  async read(providerId: string): Promise<Credential | undefined> {
    const row = this.db.all<{ value: string; seed: string }>(
      "SELECT value,seed FROM model_credentials WHERE provider=?",
      providerId
    )[0]
    // A new deployment credential explicitly replaces the old grant; unchanged seeds retain rotated tokens.
    if (this.seed && (!row || row.seed !== this.seed)) {
      const credential = decodeCredential(JSON.parse(this.seed))
      this.db.run(
        "INSERT INTO model_credentials VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,seed=excluded.seed",
        providerId,
        JSON.stringify(credential),
        this.seed
      )
      return credential
    }
    return row ? decodeCredential(JSON.parse(row.value)) : undefined
  }
  async list() {
    const credential = await this.read("openai")
    return credential ? [{ providerId: "openai", type: credential.type }] : []
  }
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>
  ): Promise<Credential | undefined> {
    const prior = this.lock
    let unlock!: () => void
    this.lock = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await prior
    try {
      const current = await this.read(providerId),
        next = await fn(current)
      if (next)
        this.db.run(
          "INSERT INTO model_credentials VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,seed=excluded.seed",
          providerId,
          JSON.stringify(next),
          this.seed
        )
      return next ?? current
    } finally {
      unlock()
    }
  }
  async delete(providerId: string) {
    await this.modify(providerId, async () => {
      this.db.run("DELETE FROM model_credentials WHERE provider=?", providerId)
      return undefined
    })
  }
}

/** All bots resolve rotating tokens through the existing owner object. */
export async function resolveAccountCredential(
  credentials: CredentialStore,
  providerId: string,
  refresh: NonNullable<OAuthAuth["refresh"]> = workerChatGPTAuth.refresh
) {
  const current = await credentials.read(providerId)
  if (current?.type !== "oauth" || current.expires > Date.now() + 5 * 60_000)
    return current
  return credentials.modify(providerId, async (latest) =>
    latest?.type === "oauth" && latest.expires <= Date.now() + 5 * 60_000
      ? refresh(latest, AbortSignal.timeout(30_000))
      : latest
  )
}

/** The account owns refresh; the child never persists a refresh token. */
export function accountCredentials(
  resolve: (provider: string) => Promise<Credential | undefined>
): CredentialStore {
  return {
    read: resolve,
    modify: (provider) => resolve(provider),
    list: async () => {
      const credential = await resolve("openai")
      return credential ? [{ providerId: "openai", type: credential.type }] : []
    },
    delete: async () => {
      throw new Error("Manage the model connection on the owner account")
    },
  }
}

export function createAgentModels(
  credentials: CredentialStore,
  options: {
    contextWindow?: (model: string) => number | undefined
    workingContextFloor?: () => number | undefined
    cacheKey?: string
    catalog?: () => Promise<ModelCatalog>
    beforeRequest?: (sessionId: string, signal?: AbortSignal) => Promise<void>
    onAttempt?: (
      model: string,
      thinking: ThinkingLevel,
      purpose: "conversation" | "compaction" | "memory",
      sessionId?: string
    ) => ReturnType<InferenceUsage["start"]>
    onUsage?: (usage: CacheUsage) => void
    waitUntil?: (work: Promise<unknown>) => void
  } = {}
) {
  const models = createModels({
    credentials: {
      ...credentials,
      read: async (provider) => {
        const credential = await credentials.read(provider)
        if (credential && credential.type !== "oauth")
          throw new Error(
            "ChatGPT subscription required. API-key fallback is disabled."
          )
        return credential
      },
      modify: (provider, fn) => credentials.modify(provider, fn),
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
          // Preserve the actual output allowance for reasoning/output reserves.
          // ChatGPT sign-in rejects max_output_tokens; metadata is not an output cap.
          maxTokens: model.maxTokens,
        }
      }),
    streamSimple(model, context, request) {
      const thinking = request?.reasoning ?? "off"
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
          if (options.catalog) {
            const capability = validateRoute(
              { model: model.id, thinking },
              await options.catalog(),
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
          if (request?.sessionId)
            await options.beforeRequest?.(request.sessionId, request.signal)
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
    const observation = options.onAttempt?.(
      model.id,
      request?.reasoning ?? "off",
      request?.sessionId === "memory"
        ? "memory"
        : request?.cacheRetention === "none"
          ? "compaction"
          : "conversation",
      request?.sessionId
    )
    let incomplete = false
    const native = nativeStream(model, context, {
      ...request,
      onProviderStreamEvent: async (event, selected) => {
        const usage = cacheUsage(event)
        if (usage) {
          options.onUsage?.(usage)
          observation?.usage(usage)
        }
        const type =
          typeof event === "object" && event !== null && "type" in event
            ? event.type
            : null
        if (type === "response.incomplete") {
          incomplete = true
          throw new Error(
            "OpenAI response incomplete. Partial output is not a completed request."
          )
        }
        await request?.onProviderStreamEvent?.(event, selected)
      },
    })
    // Native result joins the existing stream; it never issues another request.
    // Cloudflare links this duration span and provider fetch to the invocation.
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
      }).pipe(
        Effect.andThen(Effect.promise(() => native.result())),
        Effect.tap((result) =>
          Effect.annotateCurrentSpan({
            "inference.outcome": result.stopReason,
            "inference.input_tokens": result.usage.input,
            "inference.output_tokens": result.usage.output,
          })
        ),
        Effect.withSpan("Inference.request")
      )
    ).catch(() => {
      /* Native stream owns propagation of provider failures. */
    })
    try {
      options.waitUntil?.(telemetry)
    } catch {
      /* Losing a telemetry lifetime must not fail a dispatched model request. */
    }
    const observed = createAssistantMessageEventStream()
    const record = (operation: () => void) => {
      try {
        operation()
      } catch {
        Effect.runSync(
          Effect.logError("Inference.activityPersistenceFailed").pipe(
            Effect.annotateLogs({
              event: "inference.persistence_failed",
              model: model.id,
            }),
            Effect.provide(OperationalLogger)
          )
        )
      }
    }
    void (async () => {
      for await (const event of native) {
        if (event.type === "done") {
          // Installed Pi rejects streams without a terminal event; incomplete is rejected above.
          record(() => observation?.end("completed"))
        } else if (event.type === "error") {
          record(() =>
            observation?.end(
              incomplete
                ? "incomplete"
                : event.reason === "aborted"
                  ? "cancelled"
                  : "failed",
              safeInferenceError(event.error.errorMessage ?? "")
            )
          )
        }
        observed.push(event)
      }
      observed.end()
    })()
    return observed
  }
  return models
}

/** Provider errors can include request data. Only actionable categories enter Activity. */
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
