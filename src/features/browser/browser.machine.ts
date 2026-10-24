import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { BrowserState } from "@/browser/contracts"

export const BrowserView = Schema.Struct({
  agentId: Schema.String,
  visible: Schema.Boolean,
})
export type BrowserView = typeof BrowserView.Type
export const BrowserRequest = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  body: Schema.Unknown,
  interrupt: Schema.Boolean,
})
export type BrowserRequest = typeof BrowserRequest.Type
export type BrowserWork = {
  read: () => Effect.Effect<BrowserState, unknown, Scope.Scope>
  command: (
    request: BrowserRequest
  ) => Effect.Effect<BrowserState, unknown, Scope.Scope>
}
const context = Schema.Struct({
  view: BrowserView,
  state: Schema.NullOr(BrowserState),
  request: Schema.NullOr(BrowserRequest),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type Context = typeof context.Type
const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))
const message = (cause: Cause.Cause<unknown>, fallback: string) => {
  const reason = cause.reasons.find((value) => value._tag === "Fail")
  return reason?._tag === "Fail" && hasMessage(reason.error)
    ? reason.error.message
    : fallback
}
const admit = (current: Context, request: BrowserRequest) => ({
  target: "requesting",
  reenter: true,
  context: { ...current, request, error: "", failure: undefined },
})

/** Observation may be interrupted locally. Only an explicit close request closes
 * the remote session; polling never replays an action with an unknown outcome. */
export function browserMachine(work: BrowserWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: BrowserView,
      context,
      events: {
        COMMAND: BrowserRequest,
        REFRESH: Schema.Struct({}),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
      },
      emitted: {
        settled: Schema.Struct({ id: Schema.String, ok: Schema.Boolean }),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      command: createEffectLogic(({ input }: { input: BrowserRequest }) =>
        Effect.exit(work.command(input))
      ),
    },
  }).createMachine({
    id: "browser-ui",
    type: "parallel",
    context: ({ input }) => ({
      view: input,
      state: null,
      request: null,
      error: "",
      failure: undefined,
    }),
    states: {
      resource: {
        initial: "choosing",
        on: {
          VISIBILITY: ({ context, event }) =>
            event.visible === context.view.visible
              ? undefined
              : {
                  target: context.request
                    ? ".paused"
                    : event.visible
                      ? ".loading"
                      : ".hidden",
                  context: {
                    ...context,
                    view: { ...context.view, visible: event.visible },
                  },
                },
        },
        states: {
          choosing: {
            always: ({ context }) => ({
              target: context.view.visible ? "loading" : "hidden",
            }),
          },
          loading: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            invoke: {
              src: "read",
              onDone: ({ context, event }) =>
                Exit.isFailure(event.output)
                  ? {
                      target: "waiting",
                      context: {
                        ...context,
                        error: message(
                          event.output.cause,
                          "Could not load the browser."
                        ),
                        failure: event.output.cause,
                      },
                    }
                  : {
                      target: "waiting",
                      context: { ...context, state: event.output.value },
                    },
            },
          },
          waiting: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
            after: { 5000: { target: "loading" } },
            on: {
              REFRESH: ({ context }) => ({
                target: "loading",
                context: { ...context, error: "" },
              }),
            },
          },
          paused: {
            always: ({ context }) =>
              !context.request
                ? { target: context.view.visible ? "loading" : "hidden" }
                : undefined,
          },
          hidden: {
            always: ({ context }) =>
              context.request ? { target: "paused" } : undefined,
          },
        },
      },
      command: {
        initial: "ready",
        states: {
          ready: {
            on: {
              COMMAND: ({ context, event }) =>
                admit(context, Schema.decodeUnknownSync(BrowserRequest)(event)),
            },
          },
          requesting: {
            on: {
              COMMAND: ({ context, event }, enq) => {
                if (
                  event.path !== "close" ||
                  !event.interrupt ||
                  context.request?.path === "close"
                ) {
                  enq.emit({ type: "settled", id: event.id, ok: false })
                  return
                }
                enq.emit({
                  type: "settled",
                  id: context.request!.id,
                  ok: false,
                })
                return admit(
                  context,
                  Schema.decodeUnknownSync(BrowserRequest)(event)
                )
              },
            },
            invoke: {
              src: "command",
              input: ({ context }) => context.request!,
              onDone: ({ context, event }, enq) => {
                const ok = Exit.isSuccess(event.output)
                enq.emit({ type: "settled", id: context.request!.id, ok })
                return {
                  target: "ready",
                  context: {
                    ...context,
                    request: null,
                    state: Exit.isSuccess(event.output)
                      ? event.output.value
                      : context.state,
                    error: Exit.isFailure(event.output)
                      ? message(
                          event.output.cause,
                          "The browser request failed."
                        )
                      : "",
                    failure: Exit.isFailure(event.output)
                      ? event.output.cause
                      : undefined,
                  },
                }
              },
            },
          },
        },
      },
    },
  })
}
