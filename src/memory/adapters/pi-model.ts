import type { CredentialStore } from "@earendil-works/pi-ai"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { Cause, Effect, Exit, Schema } from "effect"

import { createAgentModels } from "../../inference/adapters/models-pi"
import type { ModelCatalog, ResolvedRoute } from "../../inference/policy"
import {
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type MemoryError,
  type SummaryJob,
} from "../domain"
import type { SummaryProvider } from "../summary-execution"
import { SummaryFailure } from "../summary-model"
import { piSummaryCompletion } from "./pi"

export interface PiSummaryHost {
  credentials: () => CredentialStore
  options: (
    route: ResolvedRoute,
    job: SummaryJob
  ) => Parameters<typeof createAgentModels>[1]
  systemPrompt: string
}
export function piModelSummaryProvider<TRequirements>(
  host: PiSummaryHost,
  catalog: () => Effect.Effect<
    ModelCatalog,
    SummaryFailure | MemoryError,
    TRequirements
  >
): SummaryProvider<TRequirements> {
  return {
    prepare: Effect.fn("Memory.preparePiSummary")((route, job) =>
      Effect.try({
        try: () => {
          if (
            !openaiProvider()
              .getModels()
              .some((model) => model.id === route.model)
          )
            throw new SummaryFailure({ reason: "unavailable" })
          return {
            complete: Effect.fn("Memory.dispatchPiSummary")(function* (
              messages: Parameters<
                ReturnType<typeof piSummaryCompletion>["complete"]
              >[0],
              currentJob: SummaryJob
            ) {
              const context = yield* Effect.context<TRequirements>()
              let catalogCause:
                | Cause.Cause<SummaryFailure | MemoryError>
                | undefined
              const result = yield* piSummaryCompletion(
                (nativeMessages, signal) => {
                  const models = createAgentModels(host.credentials(), {
                    ...host.options(route, job),
                    // Genuine SDK callback: reuse this invocation's services and
                    // signal. Restore its Exit after the SDK reports completion.
                    catalog: () =>
                      Effect.runPromiseExitWith(context)(catalog(), {
                        signal,
                      }).then((exit) => {
                        if (Exit.isSuccess(exit)) return exit.value
                        catalogCause = catalogCause
                          ? Cause.combine(catalogCause, exit.cause)
                          : exit.cause
                        throw new Error(
                          "Summary model authority could not be read"
                        )
                      }),
                  })
                  const model = models.getModel("openai", route.model)
                  if (!model)
                    throw new SummaryFailure({ reason: "unavailable" })
                  return models.completeSimple(
                    model,
                    {
                      systemPrompt: host.systemPrompt,
                      messages: nativeMessages,
                    },
                    {
                      reasoning:
                        route.thinking === "off" ? undefined : route.thinking,
                      signal,
                      cacheRetention: "short",
                      sessionId: "memory",
                    }
                  )
                }
              )
                .complete(messages, currentJob)
                .pipe(Effect.exit)
              if (catalogCause) {
                if (
                  Exit.isFailure(result) &&
                  (Cause.hasDies(result.cause) ||
                    Cause.hasInterrupts(result.cause))
                )
                  catalogCause = Cause.combine(catalogCause, result.cause)
                return yield* Effect.failCause(catalogCause)
              }
              return yield* result
            }),
          }
        },
        catch: (cause) => {
          const knownFailure = Schema.decodeUnknownOption(
            Schema.Union([
              SummaryFailure,
              InvalidMemory,
              MemoryNotReady,
              MemoryStorageError,
            ])
          )(cause)
          if (knownFailure._tag === "Some") return knownFailure.value
          throw cause
        },
      })
    ),
  }
}
