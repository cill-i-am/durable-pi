import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ObjectMutation, MutationReceipt, Revision } from "@/objects/contracts"

export const ObjectProblem = Schema.Struct({
  kind: Schema.Literals(["conflict", "uncertain", "error"]),
  message: Schema.String,
  input: ObjectMutation,
})
export type ObjectProblem = typeof ObjectProblem.Type
export const ObjectDraft = Schema.Struct({
  input: ObjectMutation,
  pending: Schema.Boolean,
  problem: Schema.NullOr(ObjectProblem),
  replaces: Schema.Array(Schema.String),
})
export type ObjectDraft = typeof ObjectDraft.Type
const Outcome = Schema.Struct({
  problem: Schema.NullOr(ObjectProblem),
  applied: Schema.Boolean,
  revision: Revision,
})
type Outcome = typeof Outcome.Type
const context = Schema.Struct({
  draft: Schema.NullOr(ObjectDraft),
  request: Schema.String,
  outcome: Schema.NullOr(Outcome),
  saved: Schema.String,
  confirmed: Revision,
  settled: Schema.Array(Schema.String),
  editing: Schema.Boolean,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
type Context = typeof context.Type
export type ObjectEditWork = {
  retain: (draft: ObjectDraft | null) => Effect.Effect<void, unknown>
  save: (
    input: ObjectMutation
  ) => Effect.Effect<typeof MutationReceipt.Type, unknown, Scope.Scope>
  cancel: (
    operationId: string
  ) => Effect.Effect<{ applied: boolean }, unknown, Scope.Scope>
  problem: (cause: Cause.Cause<unknown>, input: ObjectMutation) => ObjectProblem
}
const uncertain = (input: ObjectMutation, message: string): ObjectProblem => ({
  kind: "uncertain",
  message,
  input,
})
const admit = (
  state: Context,
  request: string,
  input: ObjectMutation,
  replaces: readonly string[]
) => ({
  target: "retaining",
  context: {
    ...state,
    request,
    outcome: null,
    failure: undefined,
    draft: { input, pending: true, replaces, problem: null },
  },
})
/** Each object owns one immutable mutation and an explicit reapply lineage. */
export function objectEditMachine(work: ObjectEditWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.NullOr(ObjectDraft),
      context,
      events: {
        SUBMIT: Schema.Struct({
          request: Schema.String,
          input: ObjectMutation,
        }),
        RETRY: Schema.Struct({ request: Schema.String }),
        CANCEL: Schema.Struct({ request: Schema.String }),
        REAPPLY: Schema.Struct({
          request: Schema.String,
          operationId: ObjectMutation.fields.operationId,
          revision: Revision,
          archived: Schema.Boolean,
        }),
        DISMISS: Schema.Struct({ request: Schema.String }),
        EDIT: Schema.Struct({}),
        CANCEL_EDIT: Schema.Struct({}),
      },
      emitted: {
        settled: Schema.Struct({ id: Schema.String, ok: Schema.Boolean }),
      },
    },
    actors: {
      retain: createEffectLogic(({ input }: { input: ObjectDraft | null }) =>
        Effect.exit(work.retain(input))
      ),
      save: createEffectLogic(({ input }: { input: ObjectMutation }) =>
        Effect.exit(work.save(input))
      ),
      cancel: createEffectLogic(({ input }: { input: string }) =>
        Effect.exit(work.cancel(input))
      ),
    },
  }).createMachine({
    id: "object-edit",
    initial: "ready",
    context: ({ input }) => ({
      draft: input,
      request: "",
      outcome: null,
      saved: "",
      confirmed: 0,
      settled: [],
      editing: false,
      failure: undefined,
    }),
    on: {
      SUBMIT: ({ event }, enq) => {
        enq.emit({ type: "settled", id: event.request, ok: false })
      },
      RETRY: ({ event }, enq) => {
        enq.emit({ type: "settled", id: event.request, ok: false })
      },
      CANCEL: ({ event }, enq) => {
        enq.emit({ type: "settled", id: event.request, ok: false })
      },
      REAPPLY: ({ event }, enq) => {
        enq.emit({ type: "settled", id: event.request, ok: false })
      },
      DISMISS: ({ event }, enq) => {
        enq.emit({ type: "settled", id: event.request, ok: false })
      },
    },
    states: {
      ready: {
        initial: "classifying",
        states: {
          classifying: {
            always: ({ context }) => ({
              target: context.draft?.pending
                ? "uncertain"
                : context.draft?.problem?.kind === "conflict"
                  ? "conflict"
                  : context.draft
                    ? "failed"
                    : context.editing
                      ? "editing"
                      : "clean",
            }),
          },
          clean: {},
          editing: {},
          uncertain: {},
          conflict: {},
          failed: {},
        },
        on: {
          EDIT: ({ context }) =>
            !context.draft
              ? { target: ".editing", context: { ...context, editing: true } }
              : undefined,
          CANCEL_EDIT: ({ context }) =>
            !context.draft
              ? { target: ".clean", context: { ...context, editing: false } }
              : undefined,
          SUBMIT: ({ context, event }, enq) => {
            if (context.draft) {
              enq.emit({ type: "settled", id: event.request, ok: false })
              return
            }
            return admit(context, event.request, event.input, [])
          },
          RETRY: ({ context, event }, enq) => {
            if (!context.draft?.pending) {
              enq.emit({ type: "settled", id: event.request, ok: false })
              return
            }
            return {
              target: "saving",
              context: {
                ...context,
                request: event.request,
                failure: undefined,
                outcome: null,
                draft: { ...context.draft, problem: null },
              },
            }
          },
          CANCEL: ({ context, event }, enq) => {
            if (!context.draft?.pending) {
              enq.emit({ type: "settled", id: event.request, ok: false })
              return
            }
            return {
              target: "cancelling",
              context: {
                ...context,
                request: event.request,
                failure: undefined,
                outcome: null,
              },
            }
          },
          REAPPLY: ({ context, event }, enq) => {
            const draft = context.draft
            if (
              !draft ||
              draft.pending ||
              draft.problem?.kind !== "conflict" ||
              event.archived ||
              draft.input.action.type !== "update"
            ) {
              enq.emit({ type: "settled", id: event.request, ok: false })
              return
            }
            return admit(
              context,
              event.request,
              {
                ...draft.input,
                operationId: event.operationId,
                expectedRevision: event.revision,
              },
              [draft.input.operationId, ...draft.replaces]
            )
          },
          DISMISS: ({ context, event }, enq) => {
            if (context.draft?.pending) {
              enq.emit({ type: "settled", id: event.request, ok: false })
              return
            }
            if (!context.draft) {
              enq.emit({ type: "settled", id: event.request, ok: true })
              return {
                target: ".clean",
                context: { ...context, editing: false },
              }
            }
            return {
              target: "persisting",
              context: {
                ...context,
                request: event.request,
                outcome: { problem: null, applied: false, revision: 0 },
              },
            }
          },
        },
      },
      retaining: {
        invoke: {
          src: "retain",
          input: ({ context }) => context.draft,
          onDone: ({ context, event }, enq) => {
            if (Exit.isSuccess(event.output)) return { target: "saving" }
            enq.emit({ type: "settled", id: context.request, ok: false })
            return {
              target: "ready",
              context: {
                ...context,
                failure: event.output.cause,
                draft: {
                  ...context.draft!,
                  pending: false,
                  problem: {
                    ...work.problem(event.output.cause, context.draft!.input),
                    kind: "error" as const,
                  },
                },
              },
            }
          },
        },
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.draft!.input,
          onDone: ({ context, event }) => ({
            target: "persisting",
            context: {
              ...context,
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : undefined,
              outcome: Exit.isFailure(event.output)
                ? {
                    problem: work.problem(
                      event.output.cause,
                      context.draft!.input
                    ),
                    applied: false,
                    revision: 0,
                  }
                : {
                    problem: null,
                    applied: true,
                    revision: event.output.value.revision,
                  },
            },
          }),
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
          input: ({ context }) => context.draft!.input.operationId,
          onDone: ({ context, event }) => ({
            target: "persisting",
            context: {
              ...context,
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : undefined,
              outcome: Exit.isFailure(event.output)
                ? {
                    problem: uncertain(
                      context.draft!.input,
                      "Could not confirm cancellation. Keep this change until you reconnect."
                    ),
                    applied: false,
                    revision: 0,
                  }
                : {
                    problem: null,
                    applied: event.output.value.applied,
                    revision: 0,
                  },
            },
          }),
        },
      },
      persisting: {
        invoke: {
          src: "retain",
          input: ({ context }) =>
            context.outcome!.problem
              ? {
                  ...context.draft!,
                  pending: context.outcome!.problem.kind === "uncertain",
                  problem: context.outcome!.problem,
                }
              : null,
          onDone: ({ context, event }, enq) => {
            const draft = context.draft!,
              outcome = context.outcome!
            if (Exit.isFailure(event.output)) {
              enq.emit({ type: "settled", id: context.request, ok: false })
              return {
                target: "ready",
                context: {
                  ...context,
                  failure: event.output.cause,
                  draft: {
                    ...draft,
                    pending: true,
                    problem: uncertain(
                      draft.input,
                      "The server outcome could not be saved in this browser. Retry the same change or cancel it safely."
                    ),
                  },
                },
              }
            }
            enq.emit({
              type: "settled",
              id: context.request,
              ok: !outcome.problem,
            })
            return {
              target: "ready",
              context: {
                ...context,
                draft: outcome.problem
                  ? {
                      ...draft,
                      pending: outcome.problem.kind === "uncertain",
                      problem: outcome.problem,
                    }
                  : null,
                saved: outcome.applied
                  ? draft.input.operationId
                  : context.saved,
                confirmed: Math.max(context.confirmed, outcome.revision),
                settled: outcome.problem
                  ? context.settled
                  : [
                      ...context.settled,
                      draft.input.operationId,
                      ...draft.replaces,
                    ],
                editing: outcome.problem ? context.editing : false,
              },
            }
          },
        },
      },
    },
  })
}
