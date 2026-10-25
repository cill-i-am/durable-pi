import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Envelope, type CommunicationError, type Delivery } from "./contracts"

export type PreparedDelegation = { envelope: Envelope; replay: boolean }
export function communicationAdmissionMachine(work: {
  prepareEnvelope: Effect.Effect<PreparedDelegation, CommunicationError>
  prepareRecipient: (
    envelope: Envelope
  ) => Effect.Effect<void, CommunicationError>
  arm: Effect.Effect<number, CommunicationError>
  authorize: (envelope: Envelope) => Effect.Effect<void, CommunicationError>
  commit: (
    envelope: Envelope,
    deadline: number
  ) => Effect.Effect<Delivery, CommunicationError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<Delivery, CommunicationError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        envelope: Schema.UndefinedOr(
          Schema.declare((value): value is Envelope =>
            Schema.is(Envelope)(value)
          )
        ),
        deadline: Schema.Number,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      prepareEnvelope: createEffectLogic(Effect.exit(work.prepareEnvelope)),
      prepareRecipient: createEffectLogic(({ input }: { input: Envelope }) =>
        Effect.exit(work.prepareRecipient(input))
      ),
      arm: createEffectLogic(Effect.exit(work.arm)),
      authorize: createEffectLogic(({ input }: { input: Envelope }) =>
        Effect.exit(work.authorize(input))
      ),
      commit: createEffectLogic(
        ({ input }: { input: { envelope: Envelope; deadline: number } }) =>
          Effect.exit(work.commit(input.envelope, input.deadline))
      ),
    },
  }).createMachine({
    id: "communication-admission",
    context: () => ({
      envelope: undefined as Envelope | undefined,
      deadline: 0,
      outcome: undefined as Exit.Exit<Delivery, CommunicationError> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "preparingEnvelope",
    states: {
      preparingEnvelope: {
        invoke: {
          src: "prepareEnvelope",
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
                  target: event.output.value.replay
                    ? "committing"
                    : "preparingRecipient",
                  context: {
                    ...context,
                    envelope: event.output.value.envelope,
                  },
                },
        },
      },
      preparingRecipient: {
        invoke: {
          src: "prepareRecipient",
          input: ({ context }) => context.envelope!,
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
                  target: "authorizing",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      authorizing: {
        invoke: {
          src: "authorize",
          input: ({ context }) => context.envelope!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "committing" },
        },
      },
      committing: {
        invoke: {
          src: "commit",
          input: ({ context }) => ({
            envelope: context.envelope!,
            deadline: context.deadline,
          }),
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
