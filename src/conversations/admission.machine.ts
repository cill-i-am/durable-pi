import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { ModelCatalog, ResolvedRoute } from "../inference/policy"
import type { SubmissionReceipt } from "./admission"
import type { PreparedMessage } from "./turns"

interface AdmissionPreparation {
  prepared: PreparedMessage
  route: ResolvedRoute
  parentId: string | null
  catalog: ModelCatalog
}

/** Preparation may be interrupted. Once accepted, the immediate discovery
 * handoff is joined; the already armed durable lease owns crash recovery. */
export function conversationAdmissionMachine<E, R>(work: {
  replaying: Effect.Effect<boolean, E, R>
  prepare: Effect.Effect<AdmissionPreparation, E, R>
  validate: (prepared: AdmissionPreparation) => Effect.Effect<void, E, R>
  arm: Effect.Effect<number, E, R>
  accept: (
    prepared: AdmissionPreparation,
    deadline: number
  ) => Effect.Effect<SubmissionReceipt, E, R>
  replay: Effect.Effect<SubmissionReceipt, E, R>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<SubmissionReceipt, E> => Exit.isExit(value)
  )
  const prepared = Schema.declare(
    (value): value is AdmissionPreparation => value !== undefined
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        prepared: Schema.UndefinedOr(prepared),
        deadline: Schema.Number,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      lookup: createEffectLogic(Effect.exit(work.replaying)),
      prepare: createEffectLogic(Effect.exit(work.prepare)),
      validate: createEffectLogic(
        ({ input }: { input: AdmissionPreparation }) =>
          Effect.exit(work.validate(input))
      ),
      arm: createEffectLogic(Effect.exit(work.arm)),
      accept: createEffectLogic(
        ({
          input,
        }: {
          input: { prepared: AdmissionPreparation; deadline: number }
        }) =>
          Effect.exit(
            Effect.uninterruptible(work.accept(input.prepared, input.deadline))
          )
      ),
      replay: createEffectLogic(
        Effect.exit(Effect.uninterruptible(work.replay))
      ),
    },
  }).createMachine({
    id: "conversation-admission",
    context: () => ({
      prepared: undefined as AdmissionPreparation | undefined,
      deadline: 0,
      outcome: undefined as Exit.Exit<SubmissionReceipt, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "lookingUp",
    states: {
      lookingUp: {
        invoke: {
          src: "lookup",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "replaying" : "preparing" },
        },
      },
      preparing: {
        invoke: {
          src: "prepare",
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
                  target: "checkingAdmission",
                  context: { ...context, prepared: event.output.value },
                },
        },
      },
      checkingAdmission: {
        invoke: {
          src: "lookup",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "replaying" : "validating" },
        },
      },
      validating: {
        invoke: {
          src: "validate",
          input: ({ context }) => context.prepared!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "arming" },
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
                  target: "accepting",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      accepting: {
        invoke: {
          src: "accept",
          input: ({ context }) => ({
            prepared: context.prepared!,
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
          src: "replay",
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
