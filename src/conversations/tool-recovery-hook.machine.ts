import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  RunBlocked,
  RecoveryStateRecord,
  ObservationRecord,
  type Observation,
  type RecoveryState,
} from "./recovery"
import type { RecoveryHookWork, RecoverySource } from "./recovery-service"

/** A hook scope observes a native task. It never takes ownership of that task's
 * lifetime, memo or retry. Each consequential decision is a machine transition. */
export function toolRecoveryHookMachine<E>(
  work: RecoveryHookWork<E>,
  observeFailure: <A>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<RecoveryState | undefined, E | RunBlocked> =>
      Exit.isExit(value)
  )
  const Source = Schema.Struct({
    turnId: Schema.String,
    steeringKey: Schema.String,
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        origin: Schema.UndefinedOr(Source),
        epoch: Schema.String,
        requestEpoch: Schema.String,
        observations: Schema.Array(ObservationRecord),
        previousPhase: Schema.UndefinedOr(Schema.String),
        state: Schema.declare(
          (value): value is RecoveryState | undefined =>
            value === undefined || Schema.is(RecoveryStateRecord)(value)
        ),
        outcome,
      }),
      output: outcome,
    },
    actors: {
      source: createEffectLogic(Effect.exit(observeFailure(work.source))),
      collect: createEffectLogic(({ input }: { input: RecoverySource }) =>
        Effect.exit(observeFailure(Effect.suspend(() => work.collect(input))))
      ),
      hash: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(observeFailure(Effect.suspend(() => work.hash(input))))
      ),
      remember: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(observeFailure(Effect.suspend(() => work.remember(input))))
      ),
      recall: createEffectLogic(Effect.exit(observeFailure(work.recall))),
      read: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(observeFailure(Effect.suspend(() => work.read(input))))
      ),
      commit: createEffectLogic(
        ({
          input,
        }: {
          input: {
            origin: RecoverySource
            epoch: string
            requestEpoch: string
            observations: readonly Observation[]
          }
        }) =>
          Effect.exit(observeFailure(Effect.suspend(() => work.commit(input))))
      ),
      publish: createEffectLogic(
        ({
          input,
        }: {
          input: {
            origin: RecoverySource
            state: RecoveryState | undefined
            previousPhase: string | undefined
          }
        }) =>
          Effect.exit(observeFailure(Effect.suspend(() => work.publish(input))))
      ),
      stop: createEffectLogic(Effect.exit(observeFailure(work.stop))),
    },
  }).createMachine({
    id: "tool-recovery-hook",
    initial: "readingOrigin",
    context: () => ({
      origin: undefined,
      epoch: "",
      requestEpoch: "",
      observations: [],
      previousPhase: undefined,
      state: undefined,
      outcome: Exit.succeed(undefined) as Exit.Exit<
        RecoveryState | undefined,
        E | RunBlocked
      >,
    }),
    output: ({ context }) => context.outcome,
    states: {
      readingOrigin: {
        invoke: {
          src: "source",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if (!event.output.value) return { target: "settled" }
            return {
              target: work.kind === "before" ? "hashing" : "collecting",
              context: { ...context, origin: event.output.value },
            }
          },
        },
      },
      collecting: {
        invoke: {
          src: "collect",
          input: ({ context }) => context.origin!,
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
                  target: "hashing",
                  context: { ...context, observations: event.output.value },
                },
        },
      },
      hashing: {
        invoke: {
          src: "hash",
          input: ({ context }) => context.origin!.steeringKey,
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
                  target:
                    work.kind === "before" ? "checkingBeforeMemo" : "recalling",
                  context: {
                    ...context,
                    epoch: event.output.value,
                    requestEpoch: event.output.value,
                  },
                },
        },
      },
      checkingBeforeMemo: {
        invoke: {
          src: "source",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            return {
              target:
                event.output.value?.turnId === context.origin!.turnId &&
                event.output.value.steeringKey === context.origin!.steeringKey
                  ? "remembering"
                  : "settled",
            }
          },
        },
      },
      remembering: {
        invoke: {
          src: "remember",
          input: ({ context }) => context.epoch,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "checkingCommit" },
        },
      },
      recalling: {
        invoke: {
          src: "recall",
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
                  target: "checkingCommit",
                  context: {
                    ...context,
                    requestEpoch: event.output.value ?? context.epoch,
                  },
                },
        },
      },
      checkingCommit: {
        invoke: {
          src: "source",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const current = event.output.value
            if (
              !current ||
              current.turnId !== context.origin!.turnId ||
              (work.kind === "before" &&
                current.steeringKey !== context.origin!.steeringKey)
            )
              return { target: "settled" }
            return {
              target: work.kind === "before" ? "committing" : "readingPrevious",
            }
          },
        },
      },
      readingPrevious: {
        invoke: {
          src: "read",
          input: ({ context }) => context.origin!.turnId,
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
                  target: "committing",
                  context: {
                    ...context,
                    previousPhase: event.output.value?.view?.phase,
                  },
                },
        },
      },
      committing: {
        invoke: {
          src: "commit",
          input: ({ context }) => ({
            origin: context.origin!,
            epoch: context.epoch,
            requestEpoch: context.requestEpoch,
            observations: context.observations,
          }),
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
                  target: work.kind === "before" ? "deciding" : "publishing",
                  context: {
                    ...context,
                    state: event.output.value,
                    outcome: Exit.succeed(event.output.value),
                  },
                },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => ({
            origin: context.origin!,
            state: context.state,
            previousPhase: context.previousPhase,
          }),
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "deciding" },
        },
      },
      deciding: {
        always: ({ context }) => ({
          target:
            context.state?.view?.phase === "blocked" ? "stopping" : "settled",
        }),
      },
      stopping: {
        invoke: {
          src: "stop",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.fail(
                    new RunBlocked({ message: context.state!.view!.detail })
                  ),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
