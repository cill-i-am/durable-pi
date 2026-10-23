import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ChildDispatch } from "./child-dispatch.machine"
import { type DelegationFailure, NativeId } from "./contracts"

const Outcome = Schema.declare(
  (value): value is Exit.Exit<void, DelegationFailure> => Exit.isExit(value)
)
/** Owns one child handoff through joined native settlement and durable receipt.
 * The surrounding child permit is shared by initial input, steering and messages. */
export function localDispatchMachine(work: {
  claim: Effect.Effect<ChildDispatch | undefined, DelegationFailure>
  submit: (command: ChildDispatch) => Effect.Effect<number, DelegationFailure>
  record: (
    command: ChildDispatch,
    receipt: number
  ) => Effect.Effect<void, DelegationFailure>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        command: Schema.UndefinedOr(ChildDispatch),
        receipt: Schema.UndefinedOr(NativeId),
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      claim: createEffectLogic(Effect.exit(work.claim)),
      submit: createEffectLogic(({ input }: { input: ChildDispatch }) =>
        Effect.exit(work.submit(input))
      ),
      record: createEffectLogic(
        ({ input }: { input: { command: ChildDispatch; receipt: number } }) =>
          Effect.exit(work.record(input.command, input.receipt))
      ),
    },
  }).createMachine({
    id: "local-child-native-dispatch",
    initial: "claiming",
    context: () => ({
      command: undefined as ChildDispatch | undefined,
      receipt: undefined as number | undefined,
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
                    target: "submitting",
                    context: { ...context, command: event.output.value },
                  }
                : { target: "settled" },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => context.command!,
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
                  target: "recording",
                  context: { ...context, receipt: event.output.value },
                },
        },
      },
      recording: {
        invoke: {
          src: "record",
          input: ({ context }) => ({
            command: context.command!,
            receipt: context.receipt!,
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
