import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Handoff } from "./background-domain"
import type { BackgroundError } from "./background-mailbox"
import { Group } from "./contracts"

const Outcome = Schema.declare(
  (value): value is Exit.Exit<void, BackgroundError> => Exit.isExit(value)
)
const failed = (exit: Exit.Failure<unknown, BackgroundError>) => ({
  target: "settled",
  context: {
    row: undefined,
    group: undefined,
    acknowledged: false,
    outcome: Exit.failCause(exit.cause),
  },
})
/** One native operation and its correlated acknowledgement. Neither an RPC
 * failure nor local interruption authorizes another task/native identity. */
export function backgroundAttemptMachine(work: {
  kind: "handoff" | "stop"
  claim: Effect.Effect<Handoff | undefined, BackgroundError>
  dispatch: (row: Handoff) => Effect.Effect<Group | boolean, BackgroundError>
  record: (
    row: Handoff,
    result: Group | boolean
  ) => Effect.Effect<void, BackgroundError>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        row: Schema.UndefinedOr(Handoff),
        group: Schema.UndefinedOr(Group),
        acknowledged: Schema.Boolean,
        outcome: Outcome,
      }),
      output: Outcome,
    },
    actors: {
      claim: createEffectLogic(Effect.exit(work.claim)),
      dispatch: createEffectLogic(({ input }: { input: Handoff }) =>
        Effect.exit(work.dispatch(input))
      ),
      record: createEffectLogic(
        ({ input }: { input: { row: Handoff; result: Group | boolean } }) =>
          Effect.exit(work.record(input.row, input.result))
      ),
    },
  }).createMachine({
    id: `background-${work.kind}-attempt`,
    context: () => ({
      row: undefined as Handoff | undefined,
      group: undefined as Group | undefined,
      acknowledged: false,
      outcome: Exit.void as Exit.Exit<void, BackgroundError>,
    }),
    initial: "claiming",
    output: ({ context }) => context.outcome,
    states: {
      claiming: {
        invoke: {
          src: "claim",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(event.output)
              : event.output.value
                ? {
                    target: "dispatching",
                    context: { ...context, row: event.output.value },
                  }
                : { target: "settled" },
        },
      },
      dispatching: {
        invoke: {
          src: "dispatch",
          input: ({ context }) => context.row!,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(event.output)
              : {
                  target: "recording",
                  context: {
                    ...context,
                    group:
                      typeof event.output.value === "boolean"
                        ? undefined
                        : event.output.value,
                    acknowledged:
                      typeof event.output.value === "boolean"
                        ? event.output.value
                        : false,
                  },
                },
        },
      },
      recording: {
        invoke: {
          src: "record",
          input: ({ context }) => ({
            row: context.row!,
            result: context.group ?? context.acknowledged,
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
