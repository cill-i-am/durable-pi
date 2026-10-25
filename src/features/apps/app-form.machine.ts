import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const Values = Schema.Record(Schema.String, Schema.String)
const Props = Schema.Struct({
  saved: Values,
  revision: Schema.Number,
  disabled: Schema.Boolean,
})
const Draft = Schema.Struct({ values: Values, revision: Schema.Number })
const Request = Schema.Struct({
  values: Values,
  revision: Schema.Number,
  editRevision: Schema.Number,
})
export type FormRequest = typeof Request.Type
export function appFormMachine(
  save: (request: FormRequest) => Effect.Effect<boolean, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Props,
      context: Schema.Struct({
        ...Props.fields,
        draft: Schema.NullOr(Draft),
        editRevision: Schema.Number,
        request: Schema.NullOr(Request),
        submitted: Schema.Boolean,
        cause: Schema.Unknown,
      }),
      events: {
        SYNC: Props,
        EDIT: Schema.Struct({ field: Schema.String, value: Schema.String }),
        USE_SAVED: Schema.Struct({}),
        KEEP_EDITS: Schema.Struct({}),
        SUBMIT: Schema.Struct({}),
      },
    },
    actors: {
      save: createEffectLogic(({ input }: { input: FormRequest }) =>
        Effect.exit(save(input))
      ),
    },
  }).createMachine({
    id: "app-form",
    initial: "editing",
    context: ({ input }) => ({
      ...input,
      draft: null,
      editRevision: 0,
      request: null,
      submitted: false,
      cause: undefined,
    }),
    on: {
      SYNC: ({ context, event }) => ({
        context: {
          ...context,
          saved: event.saved,
          revision: event.revision,
          disabled: event.disabled,
        },
      }),
      EDIT: ({ context, event }) =>
        context.disabled
          ? undefined
          : {
              context: {
                ...context,
                draft: {
                  values: {
                    ...(context.draft?.values ?? context.saved),
                    [event.field]: event.value,
                  },
                  revision: context.draft?.revision ?? context.revision,
                },
                editRevision: context.editRevision + 1,
                submitted: false,
              },
            },
      USE_SAVED: ({ context }) =>
        context.disabled
          ? undefined
          : {
              context: {
                ...context,
                draft: null,
                editRevision: context.editRevision + 1,
                submitted: false,
              },
            },
      KEEP_EDITS: ({ context }) =>
        context.disabled
          ? undefined
          : {
              context: {
                ...context,
                draft: {
                  values: context.draft?.values ?? context.saved,
                  revision: context.revision,
                },
                editRevision: context.editRevision + 1,
                submitted: false,
              },
            },
    },
    states: {
      editing: {
        on: {
          SUBMIT: ({ context }) =>
            context.disabled ||
            (context.draft && context.draft.revision !== context.revision)
              ? undefined
              : {
                  target: "saving",
                  context: {
                    ...context,
                    request: {
                      values: context.draft?.values ?? context.saved,
                      revision: context.draft?.revision ?? context.revision,
                      editRevision: context.editRevision,
                    },
                    submitted: false,
                  },
                },
        },
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            const accepted =
              Exit.isSuccess(event.output) &&
              event.output.value &&
              context.request!.editRevision === context.editRevision
            return {
              target: "editing",
              context: {
                ...context,
                request: null,
                draft: accepted ? null : context.draft,
                submitted: accepted,
                cause: Exit.isFailure(event.output)
                  ? event.output.cause
                  : undefined,
              },
            }
          },
        },
      },
    },
  })
}
