import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { DelegationFailure } from "./contracts"

export const BackgroundNativeCommand = Schema.Struct({
  kind: Schema.Literals(["submit", "stop"]),
  child: Schema.Number,
  request: Schema.String,
  claim: Schema.Number,
  text: Schema.String,
  steer: Schema.Boolean,
})
export type BackgroundNativeCommand = typeof BackgroundNativeCommand.Type
export interface BackgroundNativeWork {
  claim: Effect.Effect<BackgroundNativeCommand | undefined, DelegationFailure>
  dispatch: (
    command: BackgroundNativeCommand
  ) => Effect.Effect<void, DelegationFailure>
  record: (
    command: BackgroundNativeCommand,
    result: Exit.Exit<void, DelegationFailure>
  ) => Effect.Effect<void, DelegationFailure>
}
const Outcome = Schema.declare(
  (value): value is Exit.Exit<void, DelegationFailure> => Exit.isExit(value)
)
export function backgroundTaskDispatchMachine(work: BackgroundNativeWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        command: Schema.UndefinedOr(BackgroundNativeCommand),
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      claim: createEffectLogic(Effect.exit(work.claim)),
      dispatch: createEffectLogic(
        ({ input }: { input: BackgroundNativeCommand }) =>
          Effect.exit(work.dispatch(input))
      ),
      record: createEffectLogic(
        ({
          input,
        }: {
          input: {
            command: BackgroundNativeCommand
            outcome: Exit.Exit<void, DelegationFailure>
          }
        }) => Effect.exit(work.record(input.command, input.outcome))
      ),
    },
  }).createMachine({
    id: "remote-background-native-dispatch",
    initial: "claiming",
    context: () => ({
      command: undefined as BackgroundNativeCommand | undefined,
      outcome: Exit.void as Exit.Exit<void, DelegationFailure>,
    }),
    output: ({ context }) => context.outcome,
    states: {
      claiming: {
        invoke: {
          src: "claim",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value
                ? {
                    target: "dispatching",
                    context: { ...context, command: event.output.value },
                  }
                : { target: "settled" },
        },
      },
      dispatching: {
        invoke: {
          src: "dispatch",
          input: ({ context }) => context.command!,
          onDone: ({ context, event }) => ({
            target: "recording",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      recording: {
        invoke: {
          src: "record",
          input: ({ context }) => ({
            command: context.command!,
            outcome: context.outcome,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.isFailure(context.outcome)
                  ? Exit.failCause(
                      Cause.combine(context.outcome.cause, event.output.cause)
                    )
                  : event.output
                : context.outcome,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
