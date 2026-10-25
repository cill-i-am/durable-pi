import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { RoutineId } from "@/routines/contracts"
import { ConfigureWebhook, WebhookInfo } from "@/webhooks/contracts"

import { routineFailure } from "./routines-ui.machine"

export interface WebhookWork {
  read: () => Effect.Effect<WebhookInfo, unknown>
  change: (
    input: ConfigureWebhook
  ) => Effect.Effect<{ result: WebhookInfo; current: WebhookInfo }, unknown>
  resolve: (
    input: ConfigureWebhook
  ) => Effect.Effect<{ applied: boolean; current: WebhookInfo }, unknown>
}
export function webhookUiMachine(work: WebhookWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({ routineId: RoutineId }),
      context: Schema.Struct({
        routineId: RoutineId,
        info: Schema.NullOr(WebhookInfo),
        attempt: Schema.NullOr(ConfigureWebhook),
        key: Schema.NullOr(
          Schema.Struct({ value: Schema.String, revision: Schema.Int })
        ),
        error: Schema.String,
        message: Schema.String,
        failure: Schema.Unknown,
      }),
      events: {
        SEND: Schema.Struct({ change: ConfigureWebhook }),
        RESOLVE: Schema.Struct({}),
        RETRY: Schema.Struct({}),
        REFRESH: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      change: createEffectLogic(({ input }: { input: ConfigureWebhook }) =>
        Effect.exit(work.change(input))
      ),
      resolve: createEffectLogic(({ input }: { input: ConfigureWebhook }) =>
        Effect.exit(work.resolve(input))
      ),
    },
  }).createMachine({
    id: "webhook-ui",
    initial: "loading",
    context: ({ input }) => ({
      routineId: input.routineId,
      info: null,
      attempt: null,
      key: null,
      error: "",
      message: "",
      failure: null,
    }),
    states: {
      loading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    info: event.output.value,
                    error: "",
                    failure: null,
                  },
                }
              : {
                  target: "unavailable",
                  context: {
                    ...context,
                    error: routineFailure(
                      event.output.cause,
                      "Could not load webhook settings. Retry settings."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
      unavailable: { on: { REFRESH: { target: "loading" } } },
      ready: {
        on: {
          REFRESH: {
            target: "loading",
            context: ({ context }) => ({ ...context, key: null }),
          },
          SEND: ({ context, event }) =>
            event.change.routineId === context.routineId &&
            event.change.expectedRevision === context.info?.revision
              ? {
                  target: "submitting",
                  context: {
                    ...context,
                    attempt: { ...event.change },
                    key: null,
                    error: "",
                    message: "",
                    failure: null,
                  },
                }
              : undefined,
        },
      },
      submitting: {
        invoke: {
          src: "change",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: routineFailure(
                    event.output.cause,
                    "This change was not confirmed. Retry the same request or resolve it."
                  ),
                  failure: event.output.cause,
                },
              }
            const { result, current } = event.output.value,
              change = context.attempt!
            const same = current.revision === result.revision
            const keyCurrent =
              same &&
              current.enabled &&
              result.enabled &&
              result.revision === change.expectedRevision + 1
            return {
              target: "ready",
              context: {
                ...context,
                info: current,
                attempt: null,
                key:
                  change.key && keyCurrent
                    ? { value: change.key, revision: current.revision }
                    : null,
                message: !same
                  ? "The webhook changed again in another tab. Current settings have been loaded; rotate to create a new key."
                  : change.key
                    ? "Key saved. Copy it now; it cannot be retrieved later."
                    : "Webhook disabled. Unadmitted events were cancelled.",
                error: "",
                failure: null,
              },
            }
          },
        },
      },
      resolving: {
        invoke: {
          src: "resolve",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "uncertain",
                context: {
                  ...context,
                  error: routineFailure(
                    event.output.cause,
                    "Could not resolve this request and load current settings. Retry."
                  ),
                  failure: event.output.cause,
                },
              }
            const { applied, current } = event.output.value,
              attempt = context.attempt!
            return {
              target: "ready",
              context: {
                ...context,
                info: current,
                key:
                  applied &&
                  attempt.key &&
                  current.enabled &&
                  current.revision === attempt.expectedRevision + 1
                    ? { value: attempt.key, revision: current.revision }
                    : null,
                attempt: null,
                message: applied
                  ? "The change was already applied. Current settings have been loaded."
                  : "The unconfirmed change was cancelled.",
                error: "",
                failure: null,
              },
            }
          },
        },
      },
      uncertain: {
        on: {
          RETRY: {
            target: "submitting",
            context: ({ context }) => ({
              ...context,
              error: "",
              failure: null,
            }),
          },
          RESOLVE: {
            target: "resolving",
            context: ({ context }) => ({
              ...context,
              error: "",
              failure: null,
            }),
          },
        },
      },
    },
  })
}
