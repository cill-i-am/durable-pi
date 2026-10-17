import { Schema, Effect, Layer } from "effect"

import {
  ModelUnavailable,
  resolveRoute,
  validateRoute,
  type ModelCatalog,
  type ResolvedRoute,
} from "../inference/policy"
import type { ModelSettings } from "../inference/selection"
import type { MemoryError, SummaryJob } from "./domain"
import { SummaryRouting } from "./routing"
import {
  SummaryFailure,
  SummaryModel,
  type SummaryMessage,
} from "./summary-model"

export type SummaryCompletion<TRequirements = never> = {
  complete: (
    messages: readonly SummaryMessage[],
    job: SummaryJob
  ) => Effect.Effect<string, SummaryFailure | MemoryError, TRequirements>
}
export interface SummaryInputs<TRequirements = never> {
  settings: () => Effect.Effect<
    ModelSettings | undefined,
    SummaryFailure | MemoryError,
    TRequirements
  >
  catalog: () => Effect.Effect<
    ModelCatalog,
    SummaryFailure | MemoryError,
    TRequirements
  >
}
export interface SummaryProvider<TRequirements = never> {
  prepare: (
    route: ResolvedRoute,
    job: SummaryJob
  ) => Effect.Effect<
    SummaryCompletion<TRequirements>,
    SummaryFailure | MemoryError,
    TRequirements
  >
}
export function makeSummaryModel<TRequirements>(
  routing: typeof SummaryRouting.Service,
  inputs: SummaryInputs<TRequirements>,
  provider: SummaryProvider<TRequirements>
): SummaryCompletion<TRequirements> {
  return {
    complete: Effect.fn("Memory.completeSummary")(function* (messages, job) {
      const captured = yield* routing.capture(
        job,
        resolveRoute("memory", yield* inputs.settings())
      )
      const catalog = yield* inputs.catalog()
      const capability = yield* Effect.try({
        try: () => validateRoute(captured.route, catalog),
        catch: (cause) => {
          const modelUnavailable =
            Schema.decodeUnknownOption(ModelUnavailable)(cause)
          if (modelUnavailable._tag === "Some")
            return new SummaryFailure({ reason: "unavailable" })
          throw cause
        },
      })
      const route = yield* routing.budget(
        job,
        capability.contextWindow,
        captured.revision
      )
      const prepared = yield* provider.prepare(route, job)
      if (!(yield* routing.beginRequest(job, captured.revision)))
        return yield* new SummaryFailure({ reason: "unavailable" })
      return yield* prepared.complete(messages, job)
    }),
  }
}
export const summaryApplication = (
  inputs: SummaryInputs,
  provider: SummaryProvider
) =>
  Layer.effect(
    SummaryModel,
    Effect.map(SummaryRouting, (routing) =>
      makeSummaryModel(routing, inputs, provider)
    )
  )
