import {
  createEffectActor,
  createEffectLogic,
  setupEffect,
  waitFor,
} from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ModelCatalog, ResolvedRoute } from "../inference/policy"

export type SummaryRetryInspection = { applied: boolean; revision: number }
export type SummaryRetryAdmission = {
  revision: number
  candidate: ResolvedRoute
  catalog: ModelCatalog
  deadline: number
}
export interface SummaryRetryWork<E, R> {
  inspect: Effect.Effect<SummaryRetryInspection, E, R>
  configure: Effect.Effect<ResolvedRoute, E, R>
  catalog: Effect.Effect<ModelCatalog, E, R>
  arm: Effect.Effect<number, E, R>
  commit: (admission: SummaryRetryAdmission) => Effect.Effect<boolean, E, R>
  wake: Effect.Effect<void, E, R>
  notify: Effect.Effect<void, E, R>
}

/** Admission and its immediate handoff share an uninterruptible owned scope.
 * The outer machine remains interruptible during preparation. Scope closure
 * joins this inner machine through wake/notification once commitment starts. */
function retryHandoffMachine<E, R>(
  work: SummaryRetryWork<E, R>,
  admission: SummaryRetryAdmission | undefined
) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ fresh: Schema.Boolean, outcome }),
      output: outcome,
    },
    actors: {
      commit: createEffectLogic(
        Effect.exit(Effect.suspend(() => work.commit(admission!)))
      ),
      wake: createEffectLogic(Effect.exit(work.wake)),
      notify: createEffectLogic(Effect.exit(work.notify)),
    },
  }).createMachine({
    id: "memory-summary-retry-handoff",
    context: () => ({ fresh: false, outcome: Exit.void as Exit.Exit<void, E> }),
    output: ({ context }) => context.outcome,
    initial: admission ? "committing" : "waking",
    states: {
      committing: {
        invoke: {
          src: "commit",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "waking",
                  context: { ...context, fresh: event.output.value },
                },
        },
      },
      waking: {
        invoke: {
          src: "wake",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: context.fresh ? "notifying" : "settled" },
        },
      },
      notifying: {
        invoke: {
          src: "notify",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}

export function summaryRetryMachine<E, R>(work: SummaryRetryWork<E, R>) {
  const outcome = Schema.declare((value): value is Exit.Exit<void, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        revision: Schema.Number,
        candidate: Schema.UndefinedOr(ResolvedRoute),
        catalog: Schema.UndefinedOr(ModelCatalog),
        deadline: Schema.Number,
        outcome,
      }),
      output: outcome,
    },
    actors: {
      inspect: createEffectLogic(Effect.exit(work.inspect)),
      configure: createEffectLogic(Effect.exit(work.configure)),
      catalog: createEffectLogic(Effect.exit(work.catalog)),
      arm: createEffectLogic(Effect.exit(work.arm)),
      handoff: createEffectLogic(
        ({ input }: { input: SummaryRetryAdmission | undefined }) =>
          Effect.gen(function* () {
            const actor = yield* createEffectActor(
              retryHandoffMachine(work, input)
            )
            const done = yield* waitFor(
              actor,
              (state) => state.status === "done"
            ).pipe(Effect.orDie)
            return done.output!
          }).pipe(Effect.scoped, Effect.uninterruptible)
      ),
    },
  }).createMachine({
    id: "memory-summary-retry",
    context: () => ({
      revision: 0,
      candidate: undefined as ResolvedRoute | undefined,
      catalog: undefined as ModelCatalog | undefined,
      deadline: 0,
      outcome: Exit.void as Exit.Exit<void, E>,
    }),
    output: ({ context }) => context.outcome,
    initial: "inspecting",
    states: {
      inspecting: {
        invoke: {
          src: "inspect",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: event.output.value.applied
                    ? "replaying"
                    : "configuring",
                  context: {
                    ...context,
                    revision: event.output.value.revision,
                  },
                },
        },
      },
      configuring: {
        invoke: {
          src: "configure",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "discovering",
                  context: { ...context, candidate: event.output.value },
                },
        },
      },
      discovering: {
        invoke: {
          src: "catalog",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "arming",
                  context: { ...context, catalog: event.output.value },
                },
        },
      },
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "admitting",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      admitting: {
        invoke: {
          src: "handoff",
          input: ({ context }) => ({
            revision: context.revision,
            candidate: context.candidate!,
            catalog: context.catalog!,
            deadline: context.deadline,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      replaying: {
        invoke: {
          src: "handoff",
          input: () => undefined,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
