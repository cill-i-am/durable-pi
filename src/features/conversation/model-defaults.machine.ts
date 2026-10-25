import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ModelSelection, ModelSettings } from "@/conversations/turns"
import { ModelCatalogResponse } from "@/inference/catalog-api"

import {
  ModelDefaultSave,
  ModelDefaultSource,
  ModelDefaultDraft,
  sourceModelDefaults,
  observeModelDefaults,
  acknowledgeModelDefaults,
  captureModelDefaultSave,
  matchesModelDefaultSave,
  discardModelDefaultDraft,
} from "./model-defaults-draft"
export { ModelDefaultSave } from "./model-defaults-draft"

export type ModelDefaultsWork = {
  cancel: () => Effect.Effect<void, unknown>
  write: (request: ModelDefaultSave) => Effect.Effect<ModelSelection, unknown>
  acknowledge: (
    request: ModelDefaultSave,
    confirmed: ModelSelection
  ) => Effect.Effect<void, unknown>
  refresh: () => Effect.Effect<ModelCatalogResponse, unknown>
}
const messageValue = Schema.Struct({ message: Schema.String })
function message(cause: Cause.Cause<unknown>, fallback: string) {
  const reason = cause.reasons.find((value) => value._tag === "Fail")
  return reason?._tag === "Fail" && Schema.is(messageValue)(reason.error)
    ? reason.error.message
    : fallback
}
/** One immutable write; uncertain completion can only admit a read before reapply. */
export function modelDefaultsMachine(work: ModelDefaultsWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        agentId: Schema.String,
        selection: ModelSelection,
      }),
      context: ModelDefaultDraft,
      events: {
        SOURCE: ModelDefaultSource,
        JOB: ModelDefaultSource,
        CHANGE: Schema.Struct({ draft: ModelSettings }),
        CANCEL: Schema.Struct({}),
        SAVE: Schema.Struct({}),
        CHECK: Schema.Struct({}),
        REFRESH: Schema.Struct({}),
      },
    },
    actors: {
      cancel: createEffectLogic(() => Effect.exit(work.cancel())),
      write: createEffectLogic(({ input }: { input: ModelDefaultSave }) =>
        Effect.exit(work.write(input))
      ),
      acknowledge: createEffectLogic(
        ({
          input,
        }: {
          input: { request: ModelDefaultSave; confirmed: ModelSelection }
        }) => Effect.exit(work.acknowledge(input.request, input.confirmed))
      ),
      refresh: createEffectLogic(() => Effect.exit(work.refresh())),
    },
  }).createMachine({
    id: "model-defaults",
    initial: "ready",
    context: ({ input }) => ({
      agentId: input.agentId,
      job: "conversation",
      draft: {
        model: input.selection.model,
        thinking: input.selection.thinking,
      },
      baseline: {
        model: input.selection.model,
        thinking: input.selection.thinking,
      },
      settingsRevision: input.selection.settingsRevision,
      editRevision: 0,
      dirty: false,
      saved: false,
      attempt: null,
      accepted: null,
      error: "",
      failure: null,
    }),
    on: {
      SOURCE: ({ context, event }) => ({
        context: sourceModelDefaults(context, event),
      }),
      CHANGE: ({ context, event }) => ({
        context: {
          ...context,
          draft: event.draft,
          editRevision: context.editRevision + 1,
          dirty: true,
          saved: false,
        },
      }),
    },
    states: {
      ready: {
        on: {
          JOB: ({ context, event }) =>
            !context.dirty
              ? {
                  context: {
                    ...context,
                    job: event.job,
                    draft: event.draft,
                    baseline: event.draft,
                    settingsRevision: event.settingsRevision,
                    editRevision: context.editRevision + 1,
                    saved: false,
                    error: "",
                    failure: null,
                  },
                }
              : undefined,
          CANCEL: ({ context }) => ({
            context: {
              ...discardModelDefaultDraft(context),
              error: "",
              failure: null,
            },
          }),
          SAVE: ({ context }) =>
            context.dirty
              ? {
                  target: "preparing",
                  context: {
                    ...context,
                    attempt: captureModelDefaultSave(context),
                    accepted: null,
                    error: "",
                    failure: null,
                  },
                }
              : undefined,
          REFRESH: { target: "checking" },
        },
      },
      preparing: {
        invoke: {
          src: "cancel",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? { target: "writing" }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    attempt: null,
                    error: message(
                      event.output.cause,
                      "Could not prepare this save. Try again."
                    ),
                    failure: event.output.cause,
                  },
                },
        },
      },
      writing: {
        invoke: {
          src: "write",
          input: ({ context }) => context.attempt!,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "acknowledging",
                  context: { ...context, accepted: event.output.value },
                }
              : {
                  target: "unconfirmed",
                  context: {
                    ...context,
                    error: `${message(event.output.cause, "The save was not confirmed.")} Check saved settings before saving again.`,
                    failure: event.output.cause,
                  },
                },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          input: ({ context }) => ({
            request: context.attempt!,
            confirmed: context.accepted!,
          }),
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "refreshing",
                  context: acknowledgeModelDefaults(context),
                }
              : {
                  target: "ready",
                  context: {
                    ...acknowledgeModelDefaults(context),
                    attempt: null,
                    error:
                      "Default saved, but this view could not refresh. Refresh to check current settings.",
                    failure: event.output.cause,
                  },
                },
        },
      },
      refreshing: {
        invoke: {
          src: "refresh",
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: observeModelDefaults(
                    { ...context, attempt: null, error: "", failure: null },
                    event.output.value
                  ),
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    attempt: null,
                    error:
                      "Default saved, but availability could not refresh. Refresh to check current settings.",
                    failure: event.output.cause,
                  },
                },
        },
      },
      unconfirmed: {
        on: {
          CHECK: { target: "checking" },
          REFRESH: { target: "checking" },
          CANCEL: ({ context }) => ({
            context: {
              ...discardModelDefaultDraft(context),
            },
          }),
        },
      },
      checking: {
        invoke: {
          src: "refresh",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: context.attempt ? "unconfirmed" : "ready",
                context: {
                  ...context,
                  error: message(
                    event.output.cause,
                    "Could not check saved model settings."
                  ),
                  failure: event.output.cause,
                },
              }
            const catalog = event.output.value,
              attempt = context.attempt
            const latest = observeModelDefaults(context, catalog)
            if (!attempt)
              return {
                target: "ready",
                context: { ...latest, error: "", failure: null },
              }
            if (matchesModelDefaultSave(attempt, catalog))
              return {
                target: "acknowledging",
                context: {
                  ...latest,
                  accepted: catalog.selection,
                  error: "",
                  failure: null,
                },
              }
            return {
              target: "ready",
              context: {
                ...latest,
                attempt: null,
                error:
                  "Saved settings differ from this draft. Review it before saving again.",
                failure: null,
              },
            }
          },
        },
      },
    },
  })
}
