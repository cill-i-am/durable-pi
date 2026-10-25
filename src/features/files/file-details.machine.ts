import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const action = Schema.Literals(["trash", "restore", "rename", "extract"])
export type FileDetailAction = typeof action.Type
const name = Schema.String.check(Schema.isMaxLength(180))
const failure = Schema.declare((value): value is Cause.Cause<unknown> =>
  Cause.isCause(value)
)
export function fileDetailsMachine(
  mutate: (input: {
    action: FileDetailAction
    name: string
  }) => Effect.Effect<boolean, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({ name }),
      context: Schema.Struct({
        name,
        action,
        origin: Schema.Literals(["viewing", "editing"]),
        failure: Schema.NullOr(failure),
      }),
      events: {
        EDIT: Schema.Struct({ name }),
        NAME: Schema.Struct({ name }),
        CANCEL: Schema.Struct({}),
        SUBMIT: Schema.Struct({ action }),
      },
    },
    actors: {
      submit: createEffectLogic(
        ({ input }: { input: { action: FileDetailAction; name: string } }) =>
          Effect.exit(mutate(input))
      ),
    },
  }).createMachine({
    id: "file-details",
    initial: "viewing",
    context: ({ input }) => ({
      name: input.name,
      action: "trash" as FileDetailAction,
      origin: "viewing" as "viewing" | "editing",
      failure: null as Cause.Cause<unknown> | null,
    }),
    states: {
      viewing: {
        on: {
          EDIT: ({ context, event }) => ({
            target: "editing",
            context: {
              ...context,
              name: event.name,
              failure: null as Cause.Cause<unknown> | null,
            },
          }),
          SUBMIT: ({ context, event }) =>
            event.action === "rename"
              ? undefined
              : {
                  target: "submitting",
                  context: {
                    ...context,
                    action: event.action,
                    origin: "viewing",
                    failure: null as Cause.Cause<unknown> | null,
                  },
                },
        },
      },
      editing: {
        on: {
          NAME: ({ context, event }) => ({
            context: { ...context, name: event.name },
          }),
          CANCEL: { target: "viewing" },
          SUBMIT: ({ context, event }) =>
            event.action !== "rename" || !context.name.trim()
              ? undefined
              : {
                  target: "submitting",
                  context: {
                    ...context,
                    action: event.action,
                    name: context.name.trim(),
                    origin: "editing",
                    failure: null as Cause.Cause<unknown> | null,
                  },
                },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => ({
            action: context.action,
            name: context.name,
          }),
          onDone: ({ context, event }) => ({
            target:
              Exit.isSuccess(event.output) && event.output.value
                ? "viewing"
                : context.origin,
            context: {
              ...context,
              failure: Exit.isFailure(event.output) ? event.output.cause : null,
            },
          }),
        },
      },
    },
  })
}
