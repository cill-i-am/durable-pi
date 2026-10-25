import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AppAction, WebPreview } from "@/apps/contracts"

const Source = Schema.Struct({
  channel: Schema.String,
  html: Schema.String,
  preview: WebPreview,
})
export type FrameSource = typeof Source.Type
const context = Schema.Struct({
  revision: Schema.Number,
  disabled: Schema.Boolean,
  source: Schema.NullOr(Source),
  height: Schema.Number,
  error: Schema.String,
  cause: Schema.Unknown,
  action: Schema.NullOr(AppAction),
})
export type FrameEvent =
  | { type: "READY"; channel: string }
  | { type: "HEIGHT"; channel: string; height: number }
  | { type: "ERROR"; channel: string }
  | { type: "ACTION"; channel: string; action: AppAction }
export type FrameWork = {
  render: Effect.Effect<FrameSource, unknown, Scope.Scope>
  action: (
    action: AppAction,
    revision: number,
    channel: string
  ) => Effect.Effect<boolean, unknown, Scope.Scope>
  bridge: Effect.Effect<never, unknown, Scope.Scope>
}
export function webCanvasMachine(work: FrameWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        revision: Schema.Number,
        disabled: Schema.Boolean,
      }),
      context,
      events: {
        RELOAD: Schema.Struct({}),
        SYNC: Schema.Struct({
          revision: Schema.Number,
          disabled: Schema.Boolean,
        }),
        READY: Schema.Struct({ channel: Schema.String }),
        HEIGHT: Schema.Struct({
          channel: Schema.String,
          height: Schema.Number,
        }),
        ERROR: Schema.Struct({ channel: Schema.String }),
        ACTION: Schema.Struct({ channel: Schema.String, action: AppAction }),
      },
      emitted: {
        enabled: Schema.Struct({
          channel: Schema.String,
          enabled: Schema.Boolean,
        }),
      },
    },
    actors: {
      render: createEffectLogic(() => Effect.exit(work.render)),
      action: createEffectLogic(
        ({
          input,
        }: {
          input: { action: AppAction; revision: number; channel: string }
        }) =>
          Effect.exit(work.action(input.action, input.revision, input.channel))
      ),
      bridge: createEffectLogic(() => work.bridge),
    },
  }).createMachine({
    id: "web-canvas",
    initial: "owned",
    context: ({ input }) => ({
      ...input,
      source: null,
      height: 400,
      error: "",
      cause: undefined,
      action: null,
    }),
    states: {
      owned: {
        invoke: { src: "bridge" },
        initial: "rendering",
        on: {
          SYNC: ({ context, event }, enq) => {
            if (context.source)
              enq.emit({
                type: "enabled",
                channel: context.source.channel,
                enabled: false,
              })
            return {
              context: {
                ...context,
                revision: event.revision,
                disabled: event.disabled,
              },
            }
          },
          HEIGHT: ({ context, event }) =>
            event.channel === context.source?.channel &&
            Number.isFinite(event.height)
              ? {
                  context: {
                    ...context,
                    height: Math.max(240, Math.min(800, event.height)),
                  },
                }
              : undefined,
          ERROR: ({ context, event }) =>
            event.channel === context.source?.channel
              ? {
                  context: {
                    ...context,
                    error:
                      "Check the app's field names and limits before submitting.",
                  },
                }
              : undefined,
        },
        states: {
          rendering: {
            entry: ({ context }, enq) => {
              if (context.source)
                enq.emit({
                  type: "enabled",
                  channel: context.source.channel,
                  enabled: false,
                })
            },
            on: {
              RELOAD: {},
              READY: ({ event }, enq) => {
                enq.emit({
                  type: "enabled",
                  channel: event.channel,
                  enabled: false,
                })
              },
            },
            invoke: {
              src: "render",
              onDone: ({ context, event }) => ({
                target: "ready",
                context: Exit.isSuccess(event.output)
                  ? {
                      ...context,
                      source: event.output.value,
                      action: null,
                      error: "",
                      height: 400,
                    }
                  : {
                      ...context,
                      action: null,
                      error: "Could not render this app. Reload to try again.",
                      cause: event.output.cause,
                    },
              }),
            },
          },
          ready: {
            on: {
              SYNC: ({ context, event }, enq) => {
                if (context.source)
                  enq.emit({
                    type: "enabled",
                    channel: context.source.channel,
                    enabled:
                      !event.disabled &&
                      event.revision === context.source.preview.revision,
                  })
                return {
                  context: {
                    ...context,
                    revision: event.revision,
                    disabled: event.disabled,
                  },
                }
              },
              RELOAD: { target: "rendering" },
              READY: ({ context, event }, enq) => {
                if (context.source?.channel === event.channel)
                  enq.emit({
                    type: "enabled",
                    channel: event.channel,
                    enabled:
                      !context.disabled &&
                      context.source.preview.revision === context.revision,
                  })
              },
              ACTION: ({ context, event }, enq) => {
                if (
                  event.channel !== context.source?.channel ||
                  context.disabled ||
                  context.revision !== context.source.preview.revision
                )
                  return
                enq.emit({
                  type: "enabled",
                  channel: event.channel,
                  enabled: false,
                })
                return {
                  target: "acting",
                  context: { ...context, action: event.action, error: "" },
                }
              },
            },
          },
          acting: {
            on: {
              RELOAD: {},
              READY: ({ event }, enq) => {
                enq.emit({
                  type: "enabled",
                  channel: event.channel,
                  enabled: false,
                })
              },
            },
            invoke: {
              src: "action",
              input: ({ context }) => ({
                action: context.action!,
                revision: context.source!.preview.revision,
                channel: context.source!.channel,
              }),
              onDone: ({ context, event }, enq) => {
                const saved = Exit.isSuccess(event.output) && event.output.value
                if (!saved && context.source)
                  enq.emit({
                    type: "enabled",
                    channel: context.source.channel,
                    enabled:
                      !context.disabled &&
                      context.source.preview.revision === context.revision,
                  })
                return {
                  target: saved ? "rendering" : "ready",
                  context: {
                    ...context,
                    action: null,
                    error: Exit.isFailure(event.output)
                      ? "The change could not finish. Check the app status before retrying."
                      : context.error,
                    cause: Exit.isFailure(event.output)
                      ? event.output.cause
                      : context.cause,
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
