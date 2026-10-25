import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ModelSelection, ModelSettings } from "@/conversations/turns"
import { ModelCatalogResponse } from "@/inference/catalog-api"
import { JobType, resolveRoute } from "@/inference/policy"

export const ModelDefaultSave = Schema.Struct({
  agentId: Schema.String,
  job: JobType,
  draft: ModelSettings,
  editRevision: Schema.Int,
  settingsRevision: Schema.Number,
})
export type ModelDefaultSave = typeof ModelDefaultSave.Type
const Source = Schema.Struct({
  job: JobType,
  draft: ModelSettings,
  settingsRevision: Schema.Number,
})
const context = Schema.Struct({
  agentId: Schema.String,
  job: JobType,
  draft: ModelSettings,
  baseline: ModelSettings,
  editRevision: Schema.Int,
  settingsRevision: Schema.Number,
  dirty: Schema.Boolean,
  saved: Schema.Boolean,
  attempt: Schema.NullOr(ModelDefaultSave),
  accepted: Schema.NullOr(ModelSelection),
  error: Schema.String,
  failure: Schema.Unknown,
})
type State = typeof context.Type
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
function source(state: State, value: typeof Source.Type): State {
  if (
    value.job !== state.job ||
    value.settingsRevision < state.settingsRevision
  )
    return state
  return {
    ...state,
    baseline: value.draft,
    settingsRevision: value.settingsRevision,
    draft: !state.dirty && !state.attempt ? value.draft : state.draft,
  }
}
function observed(state: State, catalog: ModelCatalogResponse): State {
  return source(state, {
    job: state.job,
    draft: catalog.assignments[state.job] ?? resolveRoute(state.job),
    settingsRevision: catalog.selection.settingsRevision,
  })
}
function acknowledged(state: State): State {
  const attempt = state.attempt!,
    confirmed = state.accepted!
  const unchanged = attempt.editRevision === state.editRevision
  const baseline =
    confirmed.settingsRevision >= state.settingsRevision
      ? attempt.draft
      : state.baseline
  return {
    ...state,
    baseline,
    settingsRevision: Math.max(
      state.settingsRevision,
      confirmed.settingsRevision
    ),
    dirty: unchanged ? false : state.dirty,
    saved: unchanged,
    draft: unchanged || !state.dirty ? baseline : state.draft,
  }
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
      context,
      events: {
        SOURCE: Source,
        JOB: Source,
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
      SOURCE: ({ context, event }) => ({ context: source(context, event) }),
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
              ...context,
              draft: context.baseline,
              editRevision: context.editRevision + 1,
              dirty: false,
              saved: false,
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
                    attempt: {
                      agentId: context.agentId,
                      job: context.job,
                      draft: {
                        model: context.draft.model,
                        thinking: context.draft.thinking,
                      },
                      editRevision: context.editRevision,
                      settingsRevision: context.settingsRevision,
                    },
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
              ? { target: "refreshing", context: acknowledged(context) }
              : {
                  target: "ready",
                  context: {
                    ...acknowledged(context),
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
                  context: observed(
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
              ...context,
              draft: context.baseline,
              editRevision: context.editRevision + 1,
              dirty: false,
              saved: false,
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
            const latest = observed(context, catalog)
            if (!attempt)
              return {
                target: "ready",
                context: { ...latest, error: "", failure: null },
              }
            const current =
              catalog.assignments[attempt.job] ?? resolveRoute(attempt.job)
            if (
              catalog.selection.settingsRevision >= attempt.settingsRevision &&
              current.model === attempt.draft.model &&
              current.thinking === attempt.draft.thinking
            )
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
