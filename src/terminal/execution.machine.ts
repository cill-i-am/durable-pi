import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Checkpoint } from "./contracts"

export type TerminalExecutionResult = {
  exitCode: number
  saved?: Checkpoint
  exported?: Checkpoint
}
export interface TerminalExecutionWork<E> {
  kind: "command" | "session" | "import" | "export"
  close: Effect.Effect<void, E>
  restore: Effect.Effect<void, E>
  command: Effect.Effect<number, E>
  import: Effect.Effect<void, E>
  session: Effect.Effect<void, E>
  export: Effect.Effect<Checkpoint, E>
  checkpoint: Effect.Effect<Checkpoint, E>
}
export function terminalExecutionMachine<E>(work: TerminalExecutionWork<E>) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<TerminalExecutionResult, E> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        exitCode: Schema.Number,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      close: createEffectLogic(Effect.exit(work.close)),
      restore: createEffectLogic(Effect.exit(work.restore)),
      command: createEffectLogic(Effect.exit(work.command)),
      import: createEffectLogic(Effect.exit(work.import)),
      session: createEffectLogic(Effect.exit(work.session)),
      export: createEffectLogic(Effect.exit(work.export)),
      checkpoint: createEffectLogic(Effect.exit(work.checkpoint)),
    },
  }).createMachine({
    id: "terminal-execution",
    context: () => ({
      exitCode: 0,
      outcome: undefined as Exit.Exit<TerminalExecutionResult, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "closing",
    states: {
      closing: {
        invoke: {
          src: "close",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "restoring" },
        },
      },
      restoring: {
        invoke: {
          src: "restore",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: work.kind },
        },
      },
      command: {
        invoke: {
          src: "command",
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
                  target: "checkpointing",
                  context: { ...context, exitCode: event.output.value },
                },
        },
      },
      import: {
        invoke: {
          src: "import",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "checkpointing" },
        },
      },
      session: {
        invoke: {
          src: "session",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "checkpointing" },
        },
      },
      export: {
        invoke: {
          src: "export",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.succeed({ exitCode: 0, exported: event.output.value }),
            },
          }),
        },
      },
      checkpointing: {
        invoke: {
          src: "checkpoint",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.succeed({
                    exitCode: context.exitCode,
                    saved: event.output.value,
                  }),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
