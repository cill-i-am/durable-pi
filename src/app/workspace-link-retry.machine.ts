import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** One explicit retry owns invalidation through its acknowledgement. Router
 * retains loading, cancellation and URL authority. A new error does not free
 * the held request or grant its old acknowledgement permission to reset. */
export function workspaceLinkRetryMachine(work: {
  current: (owner: unknown) => boolean
  invalidate: Effect.Effect<void, unknown>
  reset: (owner: unknown) => Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        owner: Schema.Unknown,
        failure: Schema.Unknown,
      }),
      events: { RETRY: Schema.Struct({ owner: Schema.Unknown }) },
    },
    actors: {
      invalidate: createEffectLogic(() => Effect.exit(work.invalidate)),
      reset: createEffectLogic(({ input }: { input: unknown }) =>
        work.reset(input)
      ),
    },
  }).createMachine({
    id: "workspace-link-retry",
    initial: "ready",
    context: { owner: null, failure: null },
    states: {
      ready: {
        on: {
          RETRY: ({ event }) =>
            work.current(event.owner)
              ? {
                  target: "invalidating",
                  context: { owner: event.owner, failure: null },
                }
              : {},
        },
      },
      invalidating: {
        invoke: {
          src: "invalidate",
          onDone: ({ event, context }) =>
            Exit.isSuccess(event.output)
              ? { target: "resetting" }
              : {
                  target: "ready",
                  context: { ...context, failure: event.output.cause },
                },
        },
      },
      resetting: {
        invoke: {
          src: "reset",
          input: ({ context }: { context: { owner: unknown } }) =>
            context.owner,
          onDone: { target: "ready" },
        },
      },
    },
  })
}
