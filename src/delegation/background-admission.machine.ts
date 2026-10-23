import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { BACKGROUND_DISCOVERY_MS } from "./background-stop.machine"

/** The receipt is accepted only while its already-armed discovery lease is
 * fresh. Losing the immediate wake acknowledgement cannot erase that lease. */
export function backgroundAdmissionMachine<A, E>(work: {
  arm: (deadline: number) => Effect.Effect<void, E>
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
      arm: createEffectLogic(
        Effect.exit(
          Effect.gen(function* () {
            const deadline =
              (yield* Clock.currentTimeMillis) + BACKGROUND_DISCOVERY_MS
            yield* work.arm(deadline)
            return deadline
          })
        )
      ),
      accept: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(work.accept(input))
      ),
      wake: createEffectLogic(Effect.exit(work.wake)),
    },
  }).createMachine({
    id: "background-admission",
    context: () => ({
      deadline: 0,
      outcome: undefined as Exit.Exit<A, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "arming",
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
