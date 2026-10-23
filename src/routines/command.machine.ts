import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { RoutineChange } from "./contracts"

type A = RoutineChange | { applied: boolean }
interface CommandContext<E> {
  armed: boolean
  deadline: number
  result: A | undefined
  outcome: Exit.Exit<A, E> | undefined
}

/** Arming precedes any mutation that enables future routine work. A failed
 * acknowledgement retains the committed operation receipt and discovery. */
export function routineCommandMachine<E, R>(work: {
  needsDiscovery: Effect.Effect<boolean, E, R>
  arm: Effect.Effect<number, E, R>
  execute: (deadline: number) => Effect.Effect<A, E, R>
  acknowledge: Effect.Effect<unknown, E, R>
}) {
  type C = CommandContext<E>
  const contextSchema = Schema.declare(
    (value): value is C =>
      typeof value === "object" && value !== null && "deadline" in value
  )
  const outcome = Schema.declare((value): value is Exit.Exit<A, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: contextSchema, output: outcome },
    actors: {
      lookup: createEffectLogic(Effect.exit(work.needsDiscovery)),
      arm: createEffectLogic(Effect.exit(work.arm)),
      execute: createEffectLogic(({ input }: { input: number }) =>
        Effect.exit(Effect.uninterruptible(work.execute(input)))
      ),
      acknowledge: createEffectLogic(Effect.exit(work.acknowledge)),
    },
  }).createMachine({
    id: "routine-command",
    initial: "lookingUp",
    context: (): C => ({
      armed: false,
      deadline: 0,
      result: undefined,
      outcome: undefined,
    }),
    output: ({ context }) => context.outcome!,
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
              : { target: event.output.value ? "arming" : "applying" },
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
                  target: "applying",
                  context: {
                    ...context,
                    armed: true,
                    deadline: event.output.value,
                  },
                },
        },
      },
      applying: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.deadline,
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
                  target: context.armed ? "acknowledging" : "settled",
                  context: {
                    ...context,
                    result: event.output.value,
                    outcome: Exit.succeed(event.output.value),
                  },
                },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : Exit.succeed(context.result!),
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
