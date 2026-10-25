import { setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const BrowserPreviewView = Schema.Struct({
  agentId: Schema.String,
  generation: Schema.Number,
  version: Schema.Number,
  hasScreenshot: Schema.Boolean,
})
export type BrowserPreviewView = typeof BrowserPreviewView.Type
export const sameBrowserPreview = (
  a: BrowserPreviewView,
  b: BrowserPreviewView
) =>
  a.agentId === b.agentId &&
  a.generation === b.generation &&
  a.version === b.version &&
  a.hasScreenshot === b.hasScreenshot

/** Loading a version for one agent/session never enables another screenshot. */
export function browserPreviewMachine(refresh: () => Effect.Effect<void>) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: BrowserPreviewView,
      context: BrowserPreviewView,
      events: {
        VIEW: BrowserPreviewView,
        LOADED: BrowserPreviewView,
        FAILED: BrowserPreviewView,
      },
    },
    actions: { refresh: (_args: { context: BrowserPreviewView }) => refresh() },
  }).createMachine({
    id: "browser-preview",
    initial: "choosing",
    context: ({ input }) => input,
    on: {
      VIEW: ({ context, event }) =>
        sameBrowserPreview(context, event)
          ? undefined
          : {
              target: event.hasScreenshot ? ".loading" : ".missing",
              context: Schema.decodeUnknownSync(BrowserPreviewView)(event),
            },
    },
    states: {
      choosing: {
        always: ({ context }) => ({
          target: context.hasScreenshot ? "loading" : "missing",
        }),
      },
      missing: {},
      loading: {
        on: {
          LOADED: ({ context, event }) =>
            sameBrowserPreview(context, event)
              ? { target: "ready" }
              : undefined,
          FAILED: (args, enq) => {
            if (!sameBrowserPreview(args.context, args.event)) return
            enq(args.actions.refresh, args)
            return { target: "failed" }
          },
        },
      },
      ready: {
        on: {
          FAILED: (args, enq) => {
            if (!sameBrowserPreview(args.context, args.event)) return
            enq(args.actions.refresh, args)
            return { target: "failed" }
          },
        },
      },
      failed: {},
    },
  })
}
