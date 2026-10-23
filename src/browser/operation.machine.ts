import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type {
  BrowserCapture,
  BrowserObservation,
  BrowserRecord,
} from "./contracts"
import { BrowserCaptureRecord, BrowserRecordSchema } from "./record"

export interface BrowserOperationWork<E> {
  admit: Effect.Effect<BrowserRecord, E>
  acquire: (record: BrowserRecord) => Effect.Effect<BrowserRecord, E>
  dispatch: (record: BrowserRecord) => Effect.Effect<BrowserCapture, E>
  publish: (
    record: BrowserRecord,
    capture: BrowserCapture
  ) => Effect.Effect<BrowserObservation, E>
}
export function browserOperationMachine<E>(work: BrowserOperationWork<E>) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<BrowserObservation, E> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        record: Schema.UndefinedOr(BrowserRecordSchema),
        capture: Schema.UndefinedOr(BrowserCaptureRecord),
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      admit: createEffectLogic(Effect.exit(work.admit)),
      acquire: createEffectLogic({
        schemas: { input: BrowserRecordSchema },
        effect: ({ input }) => Effect.exit(work.acquire(input)),
      }),
      dispatch: createEffectLogic({
        schemas: { input: BrowserRecordSchema },
        effect: ({ input }) => Effect.exit(work.dispatch(input)),
      }),
      publish: createEffectLogic({
        schemas: {
          input: Schema.Struct({
            record: BrowserRecordSchema,
            capture: BrowserCaptureRecord,
          }),
        },
        effect: ({ input }) =>
          Effect.exit(work.publish(input.record, input.capture)),
      }),
    },
  }).createMachine({
    id: "browser-operation",
    initial: "admitting",
    context: () => ({
      record: undefined as BrowserRecord | undefined,
      capture: undefined as BrowserCapture | undefined,
      outcome: undefined as Exit.Exit<BrowserObservation, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      admitting: {
        invoke: {
          src: "admit",
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
                  target: event.output.value.session
                    ? "dispatching"
                    : "acquiring",
                  context: { ...context, record: event.output.value },
                },
        },
      },
      acquiring: {
        invoke: {
          src: "acquire",
          input: ({ context }) => context.record!,
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
                  target: "dispatching",
                  context: { ...context, record: event.output.value },
                },
        },
      },
      dispatching: {
        invoke: {
          src: "dispatch",
          input: ({ context }) => context.record!,
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
                  target: "publishing",
                  context: { ...context, capture: event.output.value },
                },
        },
      },
      publishing: {
        invoke: {
          src: "publish",
          input: ({ context }) => ({
            record: context.record!,
            capture: context.capture!,
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
