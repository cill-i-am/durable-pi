import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AccessState, UpdatePolicy } from "@/access/contracts"

import { accessFailureMessage } from "./decision"

export const AccessView = Schema.Struct({
  agentId: Schema.String,
  open: Schema.Boolean,
})
export type AccessView = typeof AccessView.Type
export type AccessWork = {
  read: () => Effect.Effect<AccessState, unknown, Scope.Scope>
  update: (
    input: typeof UpdatePolicy.Type
  ) => Effect.Effect<AccessState, unknown, Scope.Scope>
}
const context = Schema.Struct({
  view: AccessView,
  state: Schema.NullOr(AccessState),
  request: Schema.NullOr(UpdatePolicy),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
export function accessMachine(work: AccessWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: AccessView,
      context,
      events: {
        VIEW: Schema.Struct({ open: Schema.Boolean }),
        REFRESH: Schema.Struct({}),
        CHANGE: UpdatePolicy,
      },
      emitted: { saved: Schema.Struct({}) },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      update: createEffectLogic(
        ({ input }: { input: typeof UpdatePolicy.Type }) =>
          Effect.exit(work.update(input))
      ),
    },
  }).createMachine({
    id: "access-ui",
    initial: "choosing",
    context: ({ input }) => ({
      view: input,
      state: null,
      request: null,
      error: "",
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) => ({
        context: { ...context, view: { ...context.view, open: event.open } },
      }),
    },
    states: {
      choosing: {
        always: ({ context }) => ({
          target: context.view.open ? "loading" : "hidden",
        }),
      },
      hidden: {
        always: ({ context }) =>
          context.view.open ? { target: "loading" } : undefined,
      },
      loading: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    state: event.output.value,
                    error: "",
                    failure: undefined,
                  },
                }
              : {
                  target: "failed",
                  context: {
                    ...context,
                    error: accessFailureMessage(
                      event.output.cause,
                      "Could not load tool access. Reload to check the current permissions."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
      failed: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        on: { REFRESH: { target: "loading" } },
      },
      ready: {
        always: ({ context }) =>
          !context.view.open ? { target: "hidden" } : undefined,
        on: {
          REFRESH: { target: "loading" },
          CHANGE: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(UpdatePolicy)(event),
              current = context.state?.tools.find(
                (tool) => tool.name === request.name
              )
            return current &&
              current.revision === request.expectedRevision &&
              current.mode !== request.mode
              ? {
                  target: "saving",
                  context: {
                    ...context,
                    request,
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined
          },
        },
      },
      saving: {
        invoke: {
          src: "update",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }, enq) => {
            if (Exit.isSuccess(event.output)) {
              enq.emit({ type: "saved" })
              return {
                target: "ready",
                context: {
                  ...context,
                  state: event.output.value,
                  request: null,
                  error: "",
                  failure: undefined,
                },
              }
            }
            return {
              target: "ready",
              context: {
                ...context,
                request: null,
                error: accessFailureMessage(
                  event.output.cause,
                  "The permission change could not be confirmed. Reload to check the current permissions."
                ),
                failure: event.output.cause,
              },
            }
          },
        },
      },
    },
  })
}
