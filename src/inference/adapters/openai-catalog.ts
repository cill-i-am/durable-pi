import type { Credential, Model } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import { Clock, Effect, Schema } from "effect"

import { observeCleanup } from "../../shared/effect"
import { nativeOperation, nativeResponse } from "../../shared/interop"
import { nativeBytes } from "../../shared/stream"
import type { CatalogSource } from "../catalog"
import { reconcileCatalog } from "../domain"
import { ModelUnavailable } from "../policy"

const AccountModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      display_name: Schema.String,
      visibility: Schema.String,
      supported_in_api: Schema.optional(Schema.Boolean),
      supported_reasoning_levels: Schema.optional(
        Schema.Array(Schema.Struct({ effort: Schema.String }))
      ),
      input_modalities: Schema.optional(Schema.Array(Schema.String)),
      context_window: Schema.optional(Schema.Number),
      supports_tools: Schema.optional(Schema.Boolean),
      supports_function_calling: Schema.optional(Schema.Boolean),
    })
  ),
})
const unverified = () =>
  new ModelUnavailable({
    message: "Could not verify the ChatGPT model catalog. Try again later.",
  })

const reconcileAccount = (
  account: typeof AccountModels.Type,
  installed: readonly Model<string>[],
  now: string
) =>
  reconcileCatalog(
    account.models.map((model) => ({
      id: model.slug,
      name: model.display_name,
      visible: model.visibility === "list",
      available: model.supported_in_api !== false,
      thinking: model.supported_reasoning_levels?.map(({ effort }) =>
        effort === "none" ? "off" : effort
      ),
      input: model.input_modalities,
      contextWindow: model.context_window,
      tools:
        model.supports_tools !== false &&
        model.supports_function_calling !== false,
    })),
    installed.map((model) => ({
      id: model.id,
      name: model.name,
      thinking: getSupportedThinkingLevels(model),
      input: model.input,
      contextWindow: model.contextWindow,
      responses: model.api === "openai-responses",
    })),
    now
  )

export const catalogFromAccount = (
  value: unknown,
  installed: readonly Model<string>[],
  now: string
) =>
  reconcileAccount(
    Schema.decodeUnknownSync(AccountModels)(value),
    installed,
    now
  )

export const discoverCatalog = Effect.fn("Inference.discoverCatalog")((
  credential: Credential | undefined,
  installed: readonly Model<string>[],
  transport: typeof fetch = fetch
) => {
  if (credential?.type !== "oauth")
    return Effect.fail(
      new ModelUnavailable({
        message:
          "Connect ChatGPT to discover available models. API-key fallback is disabled.",
      })
    )
  return observeCleanup(
    Effect.scoped(
      Effect.gen(function* () {
        const response = yield* nativeResponse(
          (signal) =>
            transport("https://api.openai.com/v1/models", {
              headers: { authorization: `Bearer ${credential.access}` },
              redirect: "manual",
              signal,
            }),
          unverified
        )
        if (!response.ok)
          return yield* new ModelUnavailable({
            message:
              response.status === 401 || response.status === 403
                ? "Reconnect ChatGPT to refresh account access."
                : response.status === 429
                  ? "ChatGPT model discovery is rate limited. Try again later."
                  : "ChatGPT model discovery is temporarily unavailable.",
          })
        if (!response.body) return yield* unverified()
        const bytes = yield* nativeBytes(
          response.body,
          1_048_576,
          unverified,
          unverified
        )
        const account = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(AccountModels)
        )(new TextDecoder().decode(bytes)).pipe(Effect.mapError(unverified))
        return reconcileAccount(
          account,
          installed,
          new Date(yield* Clock.currentTimeMillis).toISOString()
        )
      })
    ),
    (observed) =>
      observed.pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            new ModelUnavailable({
              message: "ChatGPT model discovery timed out. Try again later.",
            }),
        })
      )
  )
})

export function openaiCatalogSource(
  credential: () => Effect.Effect<Credential | undefined, ModelUnavailable>,
  installed: () => readonly Model<string>[],
  transport: typeof fetch = fetch
): CatalogSource {
  return {
    current: () =>
      Effect.gen(function* () {
        const current = yield* credential()
        if (current?.type !== "oauth")
          return yield* new ModelUnavailable({
            message:
              "Connect ChatGPT to discover available models. API-key fallback is disabled.",
          })
        const fingerprint = yield* nativeOperation(
          () =>
            crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(
                JSON.stringify([current.clientId, current.access])
              )
            ),
          unverified
        )
        const identity = Array.from(new Uint8Array(fingerprint), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("")
        return {
          identity,
          load: () => discoverCatalog(current, installed(), transport),
        }
      }),
  }
}
