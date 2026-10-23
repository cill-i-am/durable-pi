import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  WebResult,
  type AppBlock,
  type AppDocument,
  type InteractApp,
  type WebPreview,
} from "./contracts"

/** A request owns the actor scope and sandbox lease. Cancellation exits the
 * invocation; closing that scope joins its native cleanup before lease reuse. */
export type AppRenderPrepared = {
  app: AppDocument
  block: Extract<AppBlock, { type: "web" }>
  state: string
  action: InteractApp["action"] | null
}
type P = AppRenderPrepared
type A = AppDocument | WebPreview
export function appRenderMachine<E>(work: {
  prepare: Effect.Effect<{ prepared: P } | { replay: A }, E>
  execute: (prepared: P) => Effect.Effect<WebResult, E>
  commit: (prepared: P, result: WebResult) => Effect.Effect<A, E>
}) {
  const outcome = Schema.declare((value): value is Exit.Exit<A, E> =>
    Exit.isExit(value)
  )
  const prepared = Schema.declare((value): value is P => value !== undefined)
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        prepared: Schema.UndefinedOr(prepared),
        result: Schema.UndefinedOr(WebResult),
        outcome: Schema.UndefinedOr(outcome),
      }),
      events: { CANCEL: Schema.Struct({ outcome }) },
      output: outcome,
    },
    actors: {
      prepare: createEffectLogic(Effect.exit(work.prepare)),
      execute: createEffectLogic(({ input }: { input: P }) =>
        Effect.exit(work.execute(input))
      ),
      commit: createEffectLogic(
        ({ input }: { input: { prepared: P; result: WebResult } }) =>
          Effect.exit(work.commit(input.prepared, input.result))
      ),
    },
  }).createMachine({
    id: "app-render",
    context: () => ({
      prepared: undefined as P | undefined,
      result: undefined as WebResult | undefined,
      outcome: undefined as Exit.Exit<A, E> | undefined,
    }),
    output: ({ context }) => context.outcome!,
    initial: "preparing",
    on: {
      CANCEL: ({ context, event }) => ({
        target: ".settled",
        context: { ...context, outcome: event.outcome },
      }),
    },
    states: {
      preparing: {
        invoke: {
          src: "prepare",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if ("replay" in event.output.value)
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.succeed(event.output.value.replay),
                },
              }
            return {
              target: "executing",
              context: { ...context, prepared: event.output.value.prepared },
            }
          },
        },
      },
      executing: {
        invoke: {
          src: "execute",
          input: ({ context }) => context.prepared!,
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
                  target: "committing",
                  context: { ...context, result: event.output.value },
                },
        },
      },
      committing: {
        invoke: {
          src: "commit",
          input: ({ context }) => ({
            prepared: context.prepared!,
            result: context.result!,
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
