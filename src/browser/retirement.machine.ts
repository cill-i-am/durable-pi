import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export function browserRetirementMachine<E>(
  close: Effect.Effect<void, E>,
  forget: Effect.Effect<void, E>
) {
  const outcome = Schema.declare((value): value is Exit.Exit<boolean, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ outcome: Schema.UndefinedOr(outcome) }),
      output: outcome,
    },
    actors: {
      close: createEffectLogic(Effect.exit(close)),
      forget: createEffectLogic(Effect.exit(forget)),
    },
  }).createMachine({
    id: "browser-retirement",
    initial: "closing",
    context: () => ({
      outcome: undefined as Exit.Exit<boolean, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      closing: {
        invoke: {
          src: "close",
          onDone: ({ event }) => {
            if (Exit.isSuccess(event.output)) return { target: "acknowledging" }
            return {
              target: "settled",
              context: {
                outcome:
                  Cause.hasDies(event.output.cause) ||
                  Cause.hasInterrupts(event.output.cause)
                    ? Exit.failCause(event.output.cause)
                    : Exit.succeed(false),
              },
            }
          },
        },
      },
      acknowledging: {
        invoke: {
          src: "forget",
          onDone: ({ event }) => ({
            target: "settled",
            context: {
              outcome: Exit.isSuccess(event.output)
                ? Exit.succeed(true)
                : Exit.failCause(event.output.cause),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
