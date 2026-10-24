import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ConfigureEmail, EmailView, RetryEmail } from "@/email/contracts"
import { WhatsAppView } from "@/whatsapp/contracts"

export const Channel = Schema.Literals(["email", "whatsapp"])
export type Channel = typeof Channel.Type
export const SettingsChange = Schema.Union([
  Schema.Struct({
    agentId: Schema.optionalKey(Schema.String),
    path: Schema.Literal("configure"),
    body: ConfigureEmail,
  }),
  Schema.Struct({
    agentId: Schema.optionalKey(Schema.String),
    path: Schema.Literal("retry"),
    body: RetryEmail,
  }),
])
export type SettingsChange = typeof SettingsChange.Type
export type SettingsView = EmailView | WhatsAppView
export const SettingsView = Schema.declare(
  (value): value is SettingsView =>
    Schema.is(EmailView)(value) || Schema.is(WhatsAppView)(value)
)
const authority = Schema.Struct({
  archived: Schema.Boolean,
  open: Schema.Boolean,
})
const input = Schema.Struct({ channel: Channel, ...authority.fields })
const outcome = Schema.declare(
  (value): value is Exit.Exit<SettingsView | null, unknown> =>
    Exit.isExit(value)
)
const contextSchema = Schema.Struct({
  ...input.fields,
  view: Schema.NullOr(SettingsView),
  request: Schema.NullOr(SettingsChange),
  outcome: Schema.UndefinedOr(outcome),
  error: Schema.String,
})
type Context = typeof contextSchema.Type
export type SettingsWork = {
  restore: Effect.Effect<SettingsChange | null, unknown>
  read: Effect.Effect<SettingsView | null, unknown, Scope.Scope>
  change: (
    request: SettingsChange
  ) => Effect.Effect<SettingsView, unknown, Scope.Scope>
  definitive: (cause: Cause.Cause<unknown>) => boolean
}
const message = (cause: Cause.Cause<unknown>) => {
  const reason = cause.reasons.find((reason) => reason._tag === "Fail")
  return reason?._tag === "Fail" &&
    Schema.is(Schema.Struct({ message: Schema.String }))(reason.error)
    ? reason.error.message
    : "The change was not confirmed. Retry the same request."
}
const allowed = (context: Context, request: SettingsChange) => {
  const view = context.view
  if (!context.open || !view) return false
  if (request.path === "configure")
    return (
      request.body.revision === view.revision &&
      (request.body.enabled
        ? view.configured && !context.archived
        : view.enabled)
    )
  return (
    view.enabled &&
    !context.archived &&
    view.messages.some(
      (item) =>
        item.id === request.body.id &&
        ["failed", "uncertain", "expired"].includes(item.state)
    )
  )
}
const submit = (context: Context, change: SettingsChange) => {
  if (
    !allowed(context, change) ||
    (change.path === "retry" && change.body.acknowledgeDuplicateRisk)
  )
    return
  const decoded = Schema.decodeUnknownSync(SettingsChange)(change)
  const request: SettingsChange =
    decoded.path === "configure"
      ? { ...decoded, body: { ...decoded.body } }
      : { ...decoded, body: { ...decoded.body } }
  const uncertain =
    request.path === "retry" &&
    context.view?.messages.some(
      (item) => item.id === request.body.id && item.state === "uncertain"
    )
  return {
    target: uncertain ? "confirming" : "changing",
    context: { ...context, request, outcome: undefined, error: "" },
  }
}

/** The server view owns channel state; this actor owns one immutable UI request. */
export function channelSettingsMachine(work: SettingsWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input,
      context: contextSchema,
      events: {
        AUTHORITY: authority,
        CHANGE: Schema.Struct({ request: SettingsChange }),
        CONFIRM: Schema.Struct({}),
        CANCEL: Schema.Struct({}),
        RETRY: Schema.Struct({}),
        REFRESH: Schema.Struct({}),
        ERROR: Schema.Struct({ message: Schema.String }),
      },
    },
    actors: {
      restore: createEffectLogic(Effect.exit(work.restore)),
      read: createEffectLogic({
        schemas: { input: Schema.Boolean },
        effect: ({ input }) =>
          Effect.exit(input ? work.read : Effect.succeed(null)),
      }),
      wait: createEffectLogic(Effect.sleep(5000)),
      change: createEffectLogic({
        schemas: { input: SettingsChange },
        effect: ({ input }) => Effect.exit(work.change(input)),
      }),
    },
  }).createMachine({
    id: "channel-settings",
    initial: "restoring",
    context: ({ input }) => ({
      ...input,
      view: null,
      request: null,
      outcome: undefined,
      error: "",
    }),
    on: {
      AUTHORITY: ({ context, event }) => ({
        context: { ...context, archived: event.archived, open: event.open },
      }),
      ERROR: ({ context, event }) => ({
        context: { ...context, error: event.message },
      }),
    },
    states: {
      restoring: {
        invoke: {
          src: "restore",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "blocked",
                  context: { ...context, error: message(event.output.cause) },
                }
              : {
                  target: "refreshing",
                  context: { ...context, request: event.output.value },
                },
        },
      },
      blocked: { on: { REFRESH: { target: "restoring" } } },
      refreshing: {
        on: {
          RETRY: ({ context }) =>
            context.open && context.request
              ? { target: "changing", context: { ...context, error: "" } }
              : undefined,
          CHANGE: ({ context, event }) =>
            context.request ? undefined : submit(context, event.request),
        },
        invoke: {
          src: "read",
          input: ({ context }) => context.open,
          onDone: ({ context, event }) => ({
            target: context.request ? "unconfirmed" : "ready",
            context: {
              ...context,
              outcome: event.output,
              view:
                Exit.isSuccess(event.output) && event.output.value
                  ? event.output.value
                  : context.view,
              error: Exit.isFailure(event.output)
                ? message(event.output.cause)
                : context.request
                  ? context.error
                  : "",
            },
          }),
        },
      },
      ready: {
        invoke: { src: "wait", onDone: { target: "refreshing" } },
        on: {
          CHANGE: ({ context, event }) => submit(context, event.request),
          REFRESH: { target: "refreshing" },
        },
      },
      confirming: {
        on: {
          CANCEL: ({ context }) => ({
            target: "ready",
            context: { ...context, request: null },
          }),
          CONFIRM: ({ context }) =>
            context.request?.path === "retry" &&
            allowed(context, context.request)
              ? {
                  target: "changing",
                  context: {
                    ...context,
                    request: {
                      ...context.request,
                      path: "retry",
                      body: {
                        ...context.request.body,
                        acknowledgeDuplicateRisk: true,
                      },
                    },
                  },
                }
              : undefined,
        },
      },
      changing: {
        invoke: {
          src: "change",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            const definitive =
              Exit.isFailure(event.output) &&
              work.definitive(event.output.cause)
            return {
              target:
                Exit.isSuccess(event.output) || definitive
                  ? "ready"
                  : "unconfirmed",
              context: {
                ...context,
                outcome: event.output,
                view: Exit.isSuccess(event.output)
                  ? event.output.value
                  : context.view,
                request:
                  Exit.isSuccess(event.output) || definitive
                    ? null
                    : context.request,
                error: Exit.isFailure(event.output)
                  ? message(event.output.cause)
                  : "",
              },
            }
          },
        },
      },
      unconfirmed: {
        invoke: { src: "wait", onDone: { target: "refreshing" } },
        on: {
          RETRY: ({ context }) =>
            context.open && context.request
              ? { target: "changing", context: { ...context, error: "" } }
              : undefined,
          REFRESH: { target: "refreshing" },
        },
      },
    },
  })
}
