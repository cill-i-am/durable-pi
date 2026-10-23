import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type { AccessError } from "./gate"
import type { DispatchDecision, ToolOperation } from "./ledger"

/** One scoped caller observing the durable ledger. Interruption stops this
 * caller and joins its work; it does not cancel the persisted operation. */
export function accessRunMachine<T, E, R>(work: {
  begin: Effect.Effect<ToolOperation, AccessError>
  claim: (
    expiresAt: number,
    waiting: boolean
  ) => Effect.Effect<
    {
      decision: DispatchDecision
      wake: Effect.Effect<void>
    },
    AccessError
  >
  execute: Effect.Effect<T, AccessError | E, R>
  replay: (result: string) => Effect.Effect<T>
}) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<T, AccessError | E> => Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        expiresAt: Schema.Number,
        waiting: Schema.Boolean,
        wake: Schema.declare((value): value is Effect.Effect<void> =>
          Effect.isEffect(value)
        ),
        receipt: Schema.String,
        outcome: Schema.UndefinedOr(outcome),
      }),
      output: outcome,
    },
    actors: {
      begin: createEffectLogic(Effect.exit(work.begin)),
      claim: createEffectLogic(
        ({ input }: { input: { expiresAt: number; waiting: boolean } }) =>
          Effect.exit(work.claim(input.expiresAt, input.waiting))
      ),
      wait: createEffectLogic(
        ({ input }: { input: Effect.Effect<void> }) => input
      ),
      execute: createEffectLogic(Effect.exit(work.execute)),
      replay: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(work.replay(input))
      ),
    },
  }).createMachine({
    id: "access-run",
    context: () => ({
      expiresAt: 0,
      waiting: false,
      wake: Effect.void,
      receipt: "",
      outcome: undefined as Exit.Exit<T, AccessError | E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "admitting",
    states: {
      admitting: {
        invoke: {
          src: "begin",
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
                  target: "claiming",
                  context: {
                    ...context,
                    expiresAt: event.output.value.expiresAt,
                  },
                },
        },
      },
      claiming: {
        invoke: {
          src: "claim",
          input: ({ context }) => ({
            expiresAt: context.expiresAt,
            waiting: context.waiting,
          }),
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const { decision, wake } = event.output.value
            if (decision === "pending")
              return {
                target: "waiting",
                context: { ...context, waiting: true, wake },
              }
            if (typeof decision === "object")
              return {
                target: "replaying",
                context: { ...context, receipt: decision.result },
              }
            return { target: "executing" }
          },
        },
      },
      waiting: {
        invoke: {
          src: "wait",
          input: ({ context }) => context.wake,
          onDone: { target: "claiming" },
        },
      },
      replaying: {
        invoke: {
          src: "replay",
          input: ({ context }) => context.receipt,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      executing: {
        invoke: {
          src: "execute",
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
