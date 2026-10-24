import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AppList } from "@/apps/contracts"

export function appListMachine(
  read: Effect.Effect<typeof AppList.Type, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({ agentId: Schema.String, visible: Schema.Boolean }),
      context: Schema.Struct({
        agentId: Schema.String,
        visible: Schema.Boolean,
        apps: AppList.fields.apps,
        loading: Schema.Boolean,
        error: Schema.String,
        cause: Schema.Unknown,
      }),
      events: {
        REFRESH: Schema.Struct({}),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
      },
    },
    actors: { read: createEffectLogic(() => Effect.exit(read)) },
  }).createMachine({
    id: "app-list",
    initial: "choosing",
    context: ({ input }) => ({
      ...input,
      apps: [],
      loading: true,
      error: "",
      cause: undefined,
    }),
    on: {
      REFRESH: { target: ".loading" },
      VISIBILITY: ({ context, event }) => ({
        context: { ...context, visible: event.visible },
      }),
    },
    states: {
      choosing: {
        always: ({ context }) => ({
          target: context.visible ? "loading" : "hidden",
        }),
      },
      hidden: {
        always: ({ context }) =>
          context.visible ? { target: "loading" } : undefined,
      },
      loading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) => ({
            target: "waiting",
            context: Exit.isSuccess(event.output)
              ? {
                  ...context,
                  apps: event.output.value.apps,
                  loading: false,
                  error: "",
                }
              : {
                  ...context,
                  loading: false,
                  error: "Could not load apps. Retry to check again.",
                  cause: event.output.cause,
                },
          }),
        },
      },
      waiting: {
        always: ({ context }) =>
          !context.visible ? { target: "hidden" } : undefined,
        after: { 4000: { target: "loading" } },
      },
    },
  })
}
