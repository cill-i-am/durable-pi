import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import {
  MailboxControl,
  MailboxView,
  terminal,
} from "@/communication/contracts"

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))

export const MailboxControlView = Schema.toType(
  Schema.Struct({
    agentId: Schema.String,
    state: Schema.NullOr(MailboxView),
  })
)
export type MailboxControlView = typeof MailboxControlView.Type
export type MailboxRequest = typeof MailboxControl.Type
export function mailboxControlAllowed(
  view: MailboxControlView,
  input: MailboxRequest,
  now: number
) {
  const state = view.state
  if (!state) return false
  if (input.action === "retry_mailbox")
    return state.recovery?.epoch === input.id
  const task = state.tasks.find((task) => task.id === input.id)
  if (input.action === "cancel")
    return (
      !!task &&
      task.direction === "outgoing" &&
      !terminal(task) &&
      !task.cancelRequested
    )
  if (
    task &&
    task.direction === "outgoing" &&
    terminal(task) &&
    !task.resumed &&
    task.control.unconfirmed
  )
    return true
  return state.deliveries.some((delivery) => {
    if (
      delivery.envelope.id !== input.id ||
      delivery.status !== "failed" ||
      delivery.envelope.deadline <= now
    )
      return false
    const task = state.tasks.find(
      (task) => task.id === delivery.envelope.taskId
    )
    return (
      !!task &&
      ((delivery.envelope.payload.kind !== "task" &&
        delivery.envelope.payload.kind !== "question") ||
        (!terminal(task) && !task.cancelRequested))
    )
  })
}
export function mailboxControlMachine(
  work: (
    view: MailboxControlView,
    input: MailboxRequest
  ) => Effect.Effect<void, unknown, Scope.Scope>,
  now: () => number = Date.now
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: MailboxControlView,
      context: Schema.Struct({
        view: MailboxControlView,
        request: Schema.NullOr(MailboxControl),
        error: Schema.String,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        VIEW: MailboxControlView,
        SUBMIT: Schema.Struct({
          agentId: Schema.String,
          ...MailboxControl.fields,
        }),
      },
      emitted: { acknowledged: MailboxControl },
    },
    actors: {
      submit: createEffectLogic(
        ({
          input,
        }: {
          input: { view: MailboxControlView; request: MailboxRequest }
        }) => Effect.exit(work(input.view, input.request))
      ),
    },
  }).createMachine({
    id: "mailbox-control-ui",
    initial: "ready",
    context: ({ input }) => ({
      view: input,
      request: null,
      error: "",
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) =>
        context.view.agentId === event.agentId
          ? {
              context: {
                ...context,
                view: Schema.decodeUnknownSync(MailboxControlView)(event),
              },
            }
          : undefined,
    },
    states: {
      ready: {
        on: {
          SUBMIT: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(MailboxControl)(event)
            if (
              event.agentId !== context.view.agentId ||
              !mailboxControlAllowed(context.view, request, now())
            )
              return
            return {
              target: "submitting",
              context: { ...context, request, error: "", failure: undefined },
            }
          },
        },
      },
      submitting: {
        invoke: {
          src: "submit",
          input: ({ context }) => ({
            view: context.view,
            request: context.request!,
          }),
          onDone: ({ context, event }, enq) => {
            if (Exit.isSuccess(event.output)) {
              enq.emit({ type: "acknowledged", ...context.request! })
              return {
                target: "ready",
                context: {
                  ...context,
                  request: null,
                  error: "",
                  failure: undefined,
                },
              }
            }
            const reason = event.output.cause.reasons.find(
              (reason) => reason._tag === "Fail"
            )
            return {
              target: "uncertain",
              context: {
                ...context,
                error:
                  reason?._tag === "Fail" && hasMessage(reason.error)
                    ? reason.error.message
                    : "The update could not be confirmed. Retry the same control.",
                failure: event.output.cause,
              },
            }
          },
        },
      },
      uncertain: {
        always: ({ context }) =>
          !mailboxControlAllowed(context.view, context.request!, now())
            ? {
                target: "ready",
                context: { ...context, request: null },
              }
            : undefined,
        on: {
          SUBMIT: ({ context, event }) => {
            const request = Schema.decodeUnknownSync(MailboxControl)(event)
            return event.agentId === context.view.agentId &&
              (request.action === "cancel" ||
                (request.id === context.request!.id &&
                  request.action === context.request!.action)) &&
              mailboxControlAllowed(context.view, request, now())
              ? {
                  target: "submitting",
                  context: {
                    ...context,
                    request,
                    error: "",
                    failure: undefined,
                  },
                }
              : undefined
          },
        },
      },
    },
  })
}
