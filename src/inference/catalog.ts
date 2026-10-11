import { Effect, Schema } from "effect"
import type { Credential, Model } from "@earendil-works/pi-ai"
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models"
import {
  ModelUnavailable,
  type ModelCatalog,
  type ModelCapability,
} from "./policy"

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

/** Account access intersects the installed Responses adapter; neither catalog alone grants access. */
export function reconcileCatalog(
  value: unknown,
  installed: readonly Model<string>[],
  now = new Date().toISOString()
): ModelCatalog {
  const account = Schema.decodeUnknownSync(AccountModels)(value)
  const models: ModelCapability[] = account.models
    .filter((m) => m.visibility === "list")
    .map((m) => {
      const native = installed.find((n) => n.id === m.slug)
      const efforts = m.supported_reasoning_levels?.map((e) =>
        e.effort === "none" ? "off" : e.effort
      )
      const window = Math.min(
        native?.contextWindow ?? 0,
        m.context_window ?? native?.contextWindow ?? 0
      )
      return {
        id: m.slug,
        name: m.display_name,
        thinking: native
          ? getSupportedThinkingLevels(native).filter(
              (e) => !efforts || efforts.includes(e)
            )
          : [],
        input:
          native?.input.filter(
            (i) => !m.input_modalities || m.input_modalities.includes(i)
          ) ?? [],
        tools:
          !!native &&
          native.api === "openai-responses" &&
          m.supports_tools !== false &&
          m.supports_function_calling !== false,
        contextWindow: window,
        unavailable:
          !native ||
          native.api !== "openai-responses" ||
          m.supported_in_api === false
            ? "Not supported by the installed Pi Responses adapter."
            : window <= 0
              ? "No verified context budget."
              : null,
      }
    })
  for (const id of ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"]) {
    if (!models.some((m) => m.id === id))
      models.push({
        id,
        name: installed.find((m) => m.id === id)?.name ?? id,
        thinking: [],
        input: [],
        tools: false,
        contextWindow: 0,
        unavailable: "Not available to the connected ChatGPT account.",
      })
  }
  return { models, checkedAt: now, error: null, usage: "ChatGPT plan usage" }
}
export const discoverCatalog = Effect.fn("Inference.discoverCatalog")(
  function* (
    credential: Credential | undefined,
    installed: readonly Model<string>[],
    transport: typeof fetch = fetch
  ) {
    if (credential?.type !== "oauth")
      return yield* new ModelUnavailable({
        message:
          "Connect ChatGPT to discover available models. API-key fallback is disabled.",
      })
    return yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await transport("https://api.openai.com/v1/models", {
          headers: { authorization: `Bearer ${credential.access}` },
          signal,
        })
        if (!response.ok)
          throw new ModelUnavailable({
            message:
              response.status === 401 || response.status === 403
                ? "Reconnect ChatGPT to refresh account access."
                : response.status === 429
                  ? "ChatGPT model discovery is rate limited. Try again later."
                  : "ChatGPT model discovery is temporarily unavailable.",
          })
        return reconcileCatalog(await response.json(), installed)
      },
      catch: (cause) =>
        cause instanceof ModelUnavailable
          ? cause
          : new ModelUnavailable({
              message:
                "Could not verify the ChatGPT model catalog. Try again later.",
            }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          new ModelUnavailable({
            message: "ChatGPT model discovery timed out. Try again later.",
          }),
      })
    )
  }
)
