import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  CodeOutput,
  type CodeRun,
  type ExecutionStorageError,
} from "./contracts"

export interface ExecutionWork {
  authorize: Effect.Effect<boolean, ExecutionStorageError>
  execute: Effect.Effect<CodeOutput | null, ExecutionStorageError>
  publish: (output: CodeOutput) => Effect.Effect<CodeRun, ExecutionStorageError>
  cancel: Effect.Effect<CodeRun, ExecutionStorageError>
}
export function executionDriverMachine(work: ExecutionWork) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<CodeRun, ExecutionStorageError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        output: Schema.NullOr(CodeOutput),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      authorize: createEffectLogic(Effect.exit(work.authorize)),
      execute: createEffectLogic(Effect.exit(work.execute)),
      publish: createEffectLogic({
        schemas: { input: CodeOutput },
        effect: ({ input }) => Effect.exit(work.publish(input)),
      }),
      cancel: createEffectLogic(Effect.exit(work.cancel)),
    },
  }).createMachine({
    id: "execution-driver",
    context: () => ({
      output: null as CodeOutput | null,
      outcome: undefined as
        | Exit.Exit<CodeRun, ExecutionStorageError>
        | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "authorizing",
    states: {
      authorizing: {
        invoke: {
          src: "authorize",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: event.output.value ? "executing" : "cancelling" },
        },
      },
      executing: {
        invoke: {
          src: "execute",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value === null
                ? { target: "cancelling" }
                : {
                    target: "publishing",
                    context: { ...context, output: event.output.value },
                  },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => context.output!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
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
