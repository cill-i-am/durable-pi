import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Control, NativeId } from "@/delegation/contracts"

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

export const BackgroundCommand = Schema.Struct({
  groupId: NativeId,
  operationId: Control.fields.operationId,
  action: Schema.Literals(["stop", "retry"]),
})
export const TaskCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("background"),
    body: BackgroundCommand,
  }),
  Schema.Struct({ kind: Schema.Literal("child"), body: Control }),
])
export type TaskCommand = typeof TaskCommand.Type
const Action = Schema.Literals(["stop", "steer", "retry"])
export const TaskControlView = Schema.Struct({
  agentId: Schema.String,
  groupId: NativeId,
  childId: Schema.NullOr(NativeId),
  prefix: Schema.Literals(["background", "delegations"]),
  active: Schema.Array(Action),
})
export type TaskControlView = typeof TaskControlView.Type
const Intent = Schema.Struct({ action: Action, text: Schema.String })
export type TaskIntent = typeof Intent.Type
export const commandAction = (command: TaskCommand) =>
  command.kind === "background" ? command.body.action : command.body.action.type
export const sameTaskOwner = (a: TaskControlView, b: TaskControlView) =>
  a.agentId === b.agentId &&
  a.groupId === b.groupId &&
  a.childId === b.childId &&
  a.prefix === b.prefix
export function commandMatches(view: TaskControlView, command: TaskCommand) {
  return (
    command.body.groupId === view.groupId &&
    (command.kind === "background"
      ? view.childId === null && view.prefix === "background"
      : command.body.childId === view.childId)
  )
}
export type TaskControlWork = {
  restore: (
    view: TaskControlView
  ) => Effect.Effect<readonly TaskCommand[], unknown, Scope.Scope>
  prepare: (
    view: TaskControlView,
    intent: TaskIntent,
    saved: TaskCommand | null
  ) => Effect.Effect<TaskCommand, unknown, Scope.Scope>
  submit: (
    view: TaskControlView,
    command: TaskCommand
  ) => Effect.Effect<void, unknown, Scope.Scope>
  rejected: (cause: Cause.Cause<unknown>) => boolean
}
const context = Schema.Struct({
  view: TaskControlView,
  saved: Schema.Array(TaskCommand),
  intent: Schema.NullOr(Intent),
  request: Schema.NullOr(TaskCommand),
  acknowledged: Schema.NullOr(TaskCommand),
  error: Schema.String,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
function failureMessage(cause: Cause.Cause<unknown>) {
  const reason = cause.reasons.find((reason) => reason._tag === "Fail")
  return reason?._tag === "Fail" && hasMessage(reason.error)
    ? reason.error.message
    : "Acknowledgement lost. Retry the saved action."
}
export function taskControlMachine(work: TaskControlWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: TaskControlView,
      context,
      events: {
        VIEW: TaskControlView,
        SUBMIT: Schema.Struct({ view: TaskControlView, ...Intent.fields }),
        RELOAD: Schema.Struct({}),
      },
    },
    actors: {
      restore: createEffectLogic(({ input }: { input: TaskControlView }) =>
        Effect.exit(work.restore(input))
      ),
      prepare: createEffectLogic(
        ({
          input,
        }: {
          input: {
            view: TaskControlView
            intent: TaskIntent
            saved: TaskCommand | null
          }
        }) => Effect.exit(work.prepare(input.view, input.intent, input.saved))
      ),
      submit: createEffectLogic(
        ({
          input,
        }: {
          input: { view: TaskControlView; command: TaskCommand }
        }) => Effect.exit(work.submit(input.view, input.command))
      ),
    },
  }).createMachine({
    id: "task-control-ui",
    initial: "restoring",
    context: ({ input }) => ({
      view: input,
      saved: [],
      intent: null,
      request: null,
      acknowledged: null,
      error: "",
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) =>
        sameTaskOwner(context.view, event)
          ? {
              context: {
                ...context,
                view: Schema.decodeUnknownSync(TaskControlView)(event),
              },
            }
          : undefined,
    },
    states: {
      restoring: {
        invoke: {
          src: "restore",
          input: ({ context }) => context.view,
          onDone: ({ context, event }) =>
            Exit.isSuccess(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    saved: event.output.value,
                    error: "",
                    failure: undefined,
                  },
                }
              : {
                  target: "blocked",
                  context: {
                    ...context,
                    error: failureMessage(event.output.cause),
                    failure: event.output.cause,
                  },
                },
        },
      },
      blocked: { on: { RELOAD: { target: "restoring" } } },
      ready: {
        on: {
          SUBMIT: ({ context, event }) => {
            const input = Schema.decodeUnknownSync(
              Schema.Struct({ view: TaskControlView, ...Intent.fields })
            )(event)
            if (!sameTaskOwner(context.view, input.view)) return
            const saved = context.saved.find(
              (command) => commandAction(command) === input.action
            )
            if (
              !saved &&
              ((context.saved.length && input.action !== "stop") ||
                !context.view.active.includes(input.action) ||
                (input.action === "steer" &&
                  (!input.text.trim() || input.text.trim().length > 8000)))
            )
              return
            if (
              context.view.childId === null
                ? input.action === "steer"
                : input.action === "retry"
            )
              return
            return {
              target: "preparing",
              context: {
                ...context,
                intent: { action: input.action, text: input.text.trim() },
                request: saved ?? null,
                error: "",
                failure: undefined,
              },
            }
          },
        },
      },
      preparing: {
        invoke: {
          src: "prepare",
          input: ({ context }) => ({
            view: context.view,
            intent: context.intent!,
            saved: context.request,
          }),
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "ready",
                context: {
                  ...context,
                  error: failureMessage(event.output.cause),
                  failure: event.output.cause,
                },
              }
            if (
              !commandMatches(context.view, event.output.value) ||
              commandAction(event.output.value) !== context.intent!.action
            )
              return {
                target: "blocked",
                context: {
                  ...context,
                  error:
                    "Saved control does not match this task. Reopen activity to recover it.",
                },
              }
            if (
              !context.request &&
              !context.view.active.includes(context.intent!.action)
            )
              return {
                target: "ready",
                context: {
                  ...context,
                  request: null,
                  intent: null,
                  saved: [...context.saved, event.output.value],
                  error:
                    "The task changed before this control could be sent. Its original operation is saved for explicit recovery.",
                },
              }
            return {
              target: "submitting",
              context: {
                ...context,
                request: event.output.value,
                saved: [
                  ...context.saved.filter(
                    (command) =>
                      commandAction(command) !== context.intent!.action
                  ),
                  event.output.value,
                ],
              },
            }
          },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => ({
            view: context.view,
            command: context.request!,
          }),
          onDone: ({ context, event }) => {
            const final =
              Exit.isSuccess(event.output) || work.rejected(event.output.cause)
            return {
              target: "ready",
              context: {
                ...context,
                saved: final
                  ? context.saved.filter(
                      (command) =>
                        command.body.operationId !==
                        context.request!.body.operationId
                    )
                  : context.saved,
                acknowledged: Exit.isSuccess(event.output)
                  ? context.request
                  : context.acknowledged,
                request: null,
                intent: null,
                error: Exit.isFailure(event.output)
                  ? failureMessage(event.output.cause)
                  : "",
                failure: Exit.isFailure(event.output)
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
