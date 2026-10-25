import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { VideoResult } from "@/workspace/video"

export const PreviewResource = Schema.Struct({
  key: Schema.String,
  agentId: Schema.String,
  fileId: Schema.String,
  kind: Schema.Literals(["text", "transcript", "video"]),
  eager: Schema.Boolean,
})
export type PreviewResource = typeof PreviewResource.Type
export const PreviewValue = Schema.Union([
  Schema.Struct({ text: Schema.String }),
  VideoResult,
])
export type PreviewValue = typeof PreviewValue.Type
const failure = Schema.declare((value): value is Cause.Cause<unknown> =>
  Cause.isCause(value)
)

export function filePreviewMachine(
  read: (resource: PreviewResource) => Effect.Effect<PreviewValue, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: PreviewResource,
      context: Schema.Struct({
        resource: PreviewResource,
        value: Schema.NullOr(PreviewValue),
        failure: Schema.NullOr(failure),
      }),
      events: {
        RESOURCE: PreviewResource,
        OPEN: Schema.Struct({}),
        CLOSE: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic(({ input }: { input: PreviewResource }) =>
        Effect.exit(read(input))
      ),
    },
  }).createMachine({
    id: "file-preview",
    initial: "initializing",
    context: ({ input }) => ({
      resource: input,
      value: null as PreviewValue | null,
      failure: null as Cause.Cause<unknown> | null,
    }),
    on: {
      RESOURCE: ({ context, event }) =>
        event.key === context.resource.key
          ? undefined
          : {
              target: ".initializing",
              reenter: true,
              context: {
                resource: Schema.decodeUnknownSync(PreviewResource)(event),
                value: null,
                failure: null as Cause.Cause<unknown> | null,
              },
            },
    },
    states: {
      initializing: {
        always: ({ context }) => ({
          target: context.resource.eager ? "loading" : "idle",
        }),
      },
      idle: { on: { OPEN: { target: "loading" } } },
      loading: {
        invoke: {
          src: "read",
          input: ({ context }) => context.resource,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "failed",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    value: event.output.value,
                    failure: null as Cause.Cause<unknown> | null,
                  },
                },
        },
        on: { CLOSE: { target: "idle" } },
      },
      ready: {},
      failed: {
        on: {
          OPEN: {
            target: "loading",
            context: ({ context }) => ({
              ...context,
              failure: null as Cause.Cause<unknown> | null,
            }),
          },
        },
      },
    },
  })
}
