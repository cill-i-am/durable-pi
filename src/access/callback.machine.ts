import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { describeExecutableEffect, initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

/** The synchronous SDK facade must return the same Promise before its Effect
 * actor starts. This small owner decides sharing from immutable admission data;
 * the map in the adapter only indexes its live Promise resource. */
export const toolCallbackLeaseMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Schema.Struct({ input: Schema.String }),
    context: Schema.Struct({ input: Schema.String }),
    events: {
      JOIN: Schema.Struct({ input: Schema.String }),
      SETTLED: Schema.Struct({}),
    },
    emitted: { SHARE: Schema.Struct({}), CONFLICT: Schema.Struct({}) },
  },
}).createMachine({
  id: "tool-callback-lease",
  initial: "owned",
  context: ({ input }) => input,
  states: {
    owned: {
      on: {
        JOIN: ({ context, event }, enq) => {
          enq.emit({
            type: context.input === event.input ? "SHARE" : "CONFLICT",
          })
        },
        SETTLED: { target: "released" },
      },
    },
    released: { type: "final" },
  },
})
export const beginToolCallback = (input: string) =>
  initialTransition(toolCallbackLeaseMachine, {
    input: Schema.decodeUnknownSync(Schema.String)(input),
  })[0]
export type ToolCallbackLease = ReturnType<typeof beginToolCallback>
export function shareToolCallback(lease: ToolCallbackLease, input: string) {
  const [, effects] = transition(toolCallbackLeaseMachine, lease, {
    type: "JOIN",
    input: Schema.decodeUnknownSync(Schema.String)(input),
  })
  return effects.some((effect) => {
    const descriptor = describeExecutableEffect(effect)
    return (
      descriptor.kind === "emit" &&
      Schema.is(Schema.Struct({ type: Schema.Literal("SHARE") }))(
        descriptor.event
      )
    )
  })
}
export const settleToolCallback = (lease: ToolCallbackLease) =>
  transition(toolCallbackLeaseMachine, lease, { type: "SETTLED" })[0]

/** Authority resolution and consequential gate dispatch are separate invoked
 * stages. The Access gate remains the durable operation and authority owner. */
export function toolCallbackMachine<T, E>(work: {
  authority: Effect.Effect<string, E>
  execute: (turnId: string) => Effect.Effect<T, E>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<T, E> =>
    Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        turnId: Schema.String,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      authority: createEffectLogic(Effect.exit(work.authority)),
      execute: createEffectLogic({
        schemas: { input: Schema.String },
        effect: ({ input }) => Effect.exit(work.execute(input)),
      }),
    },
  }).createMachine({
    id: "tool-callback",
    initial: "authorizing",
    context: () => ({
      turnId: "",
      outcome: undefined as Exit.Exit<T, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      authorizing: {
        invoke: {
          src: "authority",
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
                  target: "executing",
                  context: { ...context, turnId: event.output.value },
                },
        },
      },
      executing: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.turnId,
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
