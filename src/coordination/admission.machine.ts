import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** One request owns only prearm/commit/notification, never recipient execution. */
export function coordinationAdmissionMachine<A, E>(work: {
  arm: Effect.Effect<number, E>
  accept: (deadline: number) => Effect.Effect<A, E>
  wake: Effect.Effect<unknown, E>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<A, E> =>
    Exit.isExit(value)
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
      accept: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.accept(input))
      ),
      wake: createEffectLogic(Effect.exit(work.wake)),
    },
  }).createMachine({
    id: "coordination-admission",
    context: () => ({
      deadline: 0,
      outcome: undefined as Exit.Exit<A, E> | undefined,
    }),
    initial: "arming",
    output: ({ context }) => context.outcome!,
    states: {
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
          input: ({ context }) => context.deadline,
          onDone: ({ context, event }) => ({
            target: Exit.isFailure(event.output) ? "settled" : "waking",
            context: { ...context, outcome: event.output },
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
                ? Exit.failCause(event.output.cause)
                : context.outcome,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
