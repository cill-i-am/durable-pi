import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { CommunicationError } from "./contracts"

/** Cancellation revokes even after an unavailable discovery wake. Retrying
 * delivery requires a fresh discovery lease and is an explicit user command. */
export function communicationCommandMachine<T>(work: {
  kind: "cancel" | "retry"
  arm: Effect.Effect<number, CommunicationError>
  execute: (deadline: number) => Effect.Effect<T, CommunicationError>
  wake: Effect.Effect<void, CommunicationError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<T, CommunicationError> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        deadline: Schema.Number,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      arm: createEffectLogic(Effect.exit(work.arm)),
      execute: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(Effect.uninterruptible(work.execute(input)))
      ),
      wake: createEffectLogic(Effect.exit(work.wake)),
    },
  }).createMachine({
    id: "communication-command",
    initial: "arming",
    context: () => ({
      deadline: 0,
      outcome: undefined as Exit.Exit<T, CommunicationError> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: work.kind === "cancel" ? "executing" : "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : {
                  target: "executing",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      executing: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.deadline,
          onDone: ({ context, event }) => ({
            target: Exit.isFailure(event.output) ? "settled" : "waking",
            context: {
              ...context,
              outcome:
                context.outcome && Exit.isFailure(context.outcome)
                  ? Exit.isFailure(event.output)
                    ? Exit.failCause(
                        Cause.combine(context.outcome.cause, event.output.cause)
                      )
                    : context.outcome
                  : event.output,
            },
          }),
        },
      },
      waking: {
        invoke: {
          src: "wake",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? context.outcome && Exit.isFailure(context.outcome)
                  ? Exit.failCause(
                      Cause.combine(context.outcome.cause, event.output.cause)
                    )
                  : Exit.failCause(event.output.cause)
                : context.outcome,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
