import { createEffectActor, send, waitFor } from "@xstate/effect"
import { Context, Deferred, Effect, Layer } from "effect"

import {
  readFamilyGeneration,
  type FamilyAdmissionError,
  type FamilyDecision,
  type FamilyGeneration,
  type FamilyState,
} from "./family"
import { familyAdmissionMachine } from "./family-admission.machine"
import { familyGenerationMachine } from "./family-generation.machine"

export class FamilyAdmission extends Context.Service<
  FamilyAdmission,
  {
    admit: Effect.Effect<FamilyState | null, FamilyAdmissionError>
  }
>()("durable-pi/agents/FamilyAdmission") {}

export const familyAdmissionApplication = (host: {
  read: () => Effect.Effect<FamilyState | null, FamilyAdmissionError>
  generation: () => Effect.Effect<unknown>
  write: (record: FamilyGeneration) => Effect.Effect<void>
  fence: () => Effect.Effect<void, FamilyAdmissionError>
}) =>
  Layer.effect(
    FamilyAdmission,
    Effect.gen(function* () {
      const generation = yield* createEffectActor(familyGenerationMachine(host))
      return {
        admit: Effect.scoped(
          Effect.gen(function* () {
            const request = yield* createEffectActor(
              familyAdmissionMachine({
                observe: Effect.gen(function* () {
                  const epoch = generation.getSnapshot().context.epoch
                  const state = yield* host.read()
                  const saved = yield* host.generation()
                  return { epoch, state, ...readFamilyGeneration(saved) }
                }),
                check: (observation) =>
                  Effect.gen(function* () {
                    const reply = yield* Deferred.make<
                      FamilyDecision,
                      FamilyAdmissionError
                    >()
                    yield* send(generation, {
                      type: "OBSERVED",
                      ...observation,
                      reply,
                    })
                    return yield* Effect.raceFirst(
                      Deferred.await(reply),
                      waitFor(
                        generation,
                        (state) => state.status !== "active"
                      ).pipe(
                        Effect.orDie,
                        Effect.flatMap((state) =>
                          Effect.die(
                            state.status === "error"
                              ? state.error
                              : new Error("Family generation owner stopped")
                          )
                        )
                      )
                    )
                  }),
              })
            )
            const done = yield* waitFor(
              request,
              (state) => state.status === "done"
            ).pipe(Effect.orDie)
            return yield* done.output!
          })
        ),
      }
    })
  )
