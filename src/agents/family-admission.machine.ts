import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  FamilyObservation,
  type FamilyState,
  type FamilyAdmissionError,
  type FamilyDecision,
} from "./family"

/** Each request independently reads live authority; only generation changes
 * join the host owner. A delayed read cannot block a newer request's lookup. */
export function familyAdmissionMachine(work: {
  observe: Effect.Effect<FamilyObservation, FamilyAdmissionError>
  check: (
    observation: FamilyObservation
  ) => Effect.Effect<FamilyDecision, FamilyAdmissionError>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<FamilyState | null, FamilyAdmissionError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        observation: Schema.UndefinedOr(FamilyObservation),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      observe: createEffectLogic(Effect.exit(work.observe)),
      check: createEffectLogic(({ input }: { input: FamilyObservation }) =>
        Effect.exit(work.check(input))
      ),
    },
  }).createMachine({
    id: "family-admission",
    context: () => ({
      observation: undefined as FamilyObservation | undefined,
      outcome: undefined as
        | Exit.Exit<FamilyState | null, FamilyAdmissionError>
        | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "reading",
    states: {
      reading: {
        invoke: {
          src: "observe",
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
                  target: "checking",
                  context: { ...context, observation: event.output.value },
                },
        },
      },
      checking: {
        invoke: {
          src: "check",
          input: ({ context }) => context.observation!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : event.output.value.type === "retry"
                ? { target: "reading" }
                : {
                    target: "settled",
                    context: {
                      ...context,
                      outcome: Exit.succeed(event.output.value.state),
                    },
                  },
        },
      },
      settled: { type: "final" },
    },
  })
}
