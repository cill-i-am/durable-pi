import { createEffectActor, waitFor } from "@xstate/effect"
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
import { summaryScope } from "./summary-effects"
import { summaryExecutionMachine } from "./summary-execution.machine"
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
      const services = yield* Effect.context<TRequirements>()
      const provide = <A, E>(work: Effect.Effect<A, E, TRequirements>) =>
        Effect.provide(work, services)
      return yield* summaryScope((observe) =>
        Effect.gen(function* () {
          const machine = summaryExecutionMachine({
            capture: observe(
              Effect.gen(function* () {
                return yield* routing.capture(
                  job,
                  resolveRoute("memory", yield* provide(inputs.settings()))
                )
              })
            ),
            budget: (captured) =>
              observe(
                Effect.gen(function* () {
                  const catalog = yield* provide(inputs.catalog())
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
                  return yield* routing.budget(
                    job,
                    capability.contextWindow,
                    captured.revision
                  )
                })
              ),
            prepare: (route) =>
              observe(
                provide(provider.prepare(route, job)).pipe(
                  Effect.map((prepared) => ({
                    complete: (nextMessages, nextJob) =>
                      provide(prepared.complete(nextMessages, nextJob)),
                  }))
                )
              ),
            admit: (revision) =>
              observe(
                Effect.gen(function* () {
                  if (!(yield* routing.beginRequest(job, revision)))
                    return yield* new SummaryFailure({ reason: "unavailable" })
                })
              ),
            dispatch: (prepared) => observe(prepared.complete(messages, job)),
            acknowledge: (revision) =>
              observe(routing.finishRequest(job, revision)),
          })
          const actor = yield* createEffectActor(machine)
          const done = yield* waitFor(
            actor,
            (snapshot) => snapshot.status === "done"
          ).pipe(Effect.orDie)
          return yield* done.output!
        })
      )
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
