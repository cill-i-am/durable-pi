import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Redacted, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { InvitationPreview } from "../../family/contracts"

const secret = Schema.declare((value): value is Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
)
export const JoinSource = Schema.Struct({
  generation: Schema.Number,
  id: Schema.NullOr(Schema.String),
  token: Schema.NullOr(secret),
})
export type JoinSource = typeof JoinSource.Type
export const JoinInvitation = Schema.Struct({
  ...InvitationPreview.fields,
  id: Schema.String,
})
export type JoinInvitation = typeof JoinInvitation.Type
export const JoinSession = Schema.Struct({
  email: Schema.String,
  verified: Schema.Boolean,
})
export type JoinSession = typeof JoinSession.Type
export const JoinCommand = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("signin"), password: secret }),
  Schema.Struct({
    kind: Schema.Literal("signup"),
    password: secret,
    name: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("accept") }),
  Schema.Struct({ kind: Schema.Literal("resend") }),
  Schema.Struct({ kind: Schema.Literal("switch") }),
])
export type JoinCommand = typeof JoinCommand.Type
export type JoinResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; unavailable?: boolean; temporary?: boolean }
const contextSchema = Schema.Struct({
  source: JoinSource,
  queued: Schema.NullOr(JoinSource),
  invitation: Schema.NullOr(JoinInvitation),
  command: Schema.NullOr(JoinCommand),
  session: Schema.NullOr(JoinSession),
  sessionPending: Schema.Boolean,
  error: Schema.String,
  notice: Schema.String,
  signin: Schema.Boolean,
  reads: Schema.Number,
  accepted: Schema.Boolean,
})
type JoinContext = typeof contextSchema.Type
const empty = (source: JoinSource) => ({
  source,
  queued: null,
  invitation: null,
  command: null,
  error: "",
  notice: "",
  signin: !!source.token,
  reads: 0,
  accepted: false,
})
function advance(
  context: JoinContext,
  target: string,
  patch: Partial<JoinContext> = {}
) {
  return context.queued
    ? {
        target: "#family-join.working.choose",
        context: { ...context, ...empty(context.queued) },
      }
    : { target, context: { ...context, ...patch } }
}
export function joinAllowed(
  command: JoinCommand["kind"],
  invitation: JoinInvitation | null,
  session: JoinSession | null
) {
  if (!invitation || invitation.status !== "pending") return false
  if (command === "signin" || command === "signup") return session === null
  if (command === "switch") return session !== null
  return (
    session?.email.toLowerCase() === invitation.email.toLowerCase() &&
    (command === "accept" ? session.verified : !session.verified)
  )
}
export function familyJoinMachine(ports: {
  verify: (source: JoinSource) => Effect.Effect<JoinResult<void>>
  locate: (source: JoinSource) => Effect.Effect<JoinResult<string>>
  preview: (source: JoinSource) => Effect.Effect<JoinResult<JoinInvitation>>
  refresh: (source: JoinSource) => Effect.Effect<void>
  change: (
    source: JoinSource,
    invitation: JoinInvitation,
    command: JoinCommand
  ) => Effect.Effect<JoinResult<void>>
  joined: (
    source: JoinSource,
    invitation: JoinInvitation
  ) => Effect.Effect<boolean>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: contextSchema,
      events: {
        OPEN: Schema.Struct({ source: JoinSource }),
        SESSION: Schema.Struct({
          session: Schema.NullOr(JoinSession),
          pending: Schema.Boolean,
        }),
        COMMAND: Schema.Struct({ command: JoinCommand }),
        RETRY: Schema.Struct({}),
        TOGGLE: Schema.Struct({}),
        SIGNED_IN: Schema.Struct({ generation: Schema.Number }),
        EXTERNAL: Schema.Struct({
          generation: Schema.Number,
          busy: Schema.Boolean,
        }),
      },
    },
    actors: {
      verify: createEffectLogic(({ input }: { input: JoinSource }) =>
        ports.verify(input)
      ),
      locate: createEffectLogic(({ input }: { input: JoinSource }) =>
        ports.locate(input)
      ),
      preview: createEffectLogic(({ input }: { input: JoinSource }) =>
        ports.preview(input)
      ),
      refresh: createEffectLogic(({ input }: { input: JoinSource }) =>
        ports.refresh(input)
      ),
      change: createEffectLogic(
        ({
          input,
        }: {
          input: {
            source: JoinSource
            invitation: JoinInvitation
            command: JoinCommand
          }
        }) => ports.change(input.source, input.invitation, input.command)
      ),
      joined: createEffectLogic(
        ({
          input,
        }: {
          input: { source: JoinSource; invitation: JoinInvitation }
        }) => ports.joined(input.source, input.invitation)
      ),
    },
  }).createMachine({
    id: "family-join",
    initial: "empty",
    context: {
      ...empty({ generation: 0, id: null, token: null }),
      session: null,
      sessionPending: true,
    },
    on: {
      OPEN: ({ context, event }) => ({
        target: ".working.choose",
        context: { ...context, ...empty(event.source) },
      }),
      SESSION: ({ context, event }) => ({
        context: {
          ...context,
          session: event.session,
          sessionPending: event.pending,
        },
      }),
    },
    states: {
      empty: {},
      working: {
        initial: "choose",
        on: {
          OPEN: ({ context, event }) => ({
            context: { ...context, queued: event.source },
          }),
        },
        states: {
          choose: {
            always: ({ context }) => ({
              target: context.source.token ? "verify" : "locate",
            }),
          },
          verify: {
            invoke: {
              src: "verify",
              input: ({ context }) => context.source,
              onDone: ({ context, event }) =>
                advance(context, "verifiedSession", {
                  source: { ...context.source, token: null },
                  signin: true,
                  notice: event.output.ok
                    ? "Email verified. Finish joining your family below."
                    : "",
                  error: event.output.ok
                    ? ""
                    : "This verification link could not be confirmed. Resend the verification email below, or sign in to request a new link.",
                }),
            },
          },
          verifiedSession: {
            invoke: {
              src: "refresh",
              input: ({ context }) => context.source,
              onDone: ({ context }) => advance(context, "locate"),
            },
          },
          locate: {
            invoke: {
              src: "locate",
              input: ({ context }) => context.source,
              onDone: ({ context, event }) =>
                event.output.ok
                  ? advance(context, "preview", {
                      source: { ...context.source, id: event.output.value },
                    })
                  : advance(
                      context,
                      event.output.unavailable
                        ? "#family-join.unavailable"
                        : "#family-join.failed",
                      { error: event.output.error }
                    ),
            },
          },
          preview: {
            invoke: {
              src: "preview",
              input: ({ context }) => context.source,
              onDone: ({ context, event }) => {
                const result = event.output
                if (result.ok)
                  return advance(context, "#family-join.ready", {
                    invitation: result.value,
                  })
                if (result.temporary && context.reads === 0)
                  return advance(context, "retryWait", { reads: 1 })
                return advance(
                  context,
                  result.unavailable
                    ? "#family-join.unavailable"
                    : "#family-join.failed",
                  { error: result.error }
                )
              },
            },
          },
          retryWait: {
            after: { 250: ({ context }) => advance(context, "preview") },
          },
          change: {
            invoke: {
              src: "change",
              input: ({ context }) => ({
                source: context.source,
                invitation: context.invitation!,
                command: context.command!,
              }),
              onDone: ({ context, event }) => {
                if (!event.output.ok)
                  return advance(context, "#family-join.ready", {
                    command: null,
                    error: event.output.error,
                  })
                return advance(context, "changedSession", {
                  accepted: context.command?.kind === "accept",
                  notice:
                    context.command?.kind === "resend"
                      ? "Verification email sent."
                      : "",
                  command: null,
                })
              },
            },
          },
          changedSession: {
            invoke: {
              src: "refresh",
              input: ({ context }) => context.source,
              onDone: ({ context }) =>
                advance(
                  context,
                  context.accepted ? "joined" : "#family-join.ready"
                ),
            },
          },
          joined: {
            invoke: {
              src: "joined",
              input: ({ context }) => ({
                source: context.source,
                invitation: context.invitation!,
              }),
              onDone: ({ context, event }) =>
                advance(
                  context,
                  event.output ? "#family-join.welcome" : "#family-join.ready",
                  {
                    error: event.output
                      ? ""
                      : "Your account has changed. Check this invitation before continuing.",
                  }
                ),
            },
          },
        },
      },
      ready: {
        on: {
          COMMAND: ({ context, event }) =>
            !context.sessionPending &&
            joinAllowed(event.command.kind, context.invitation, context.session)
              ? {
                  target: "working.change",
                  context: {
                    ...context,
                    command: event.command,
                    error: "",
                    notice: "",
                  },
                }
              : {},
          TOGGLE: ({ context }) => ({
            context: { ...context, signin: !context.signin, error: "" },
          }),
          EXTERNAL: ({ context, event }) =>
            event.generation === context.source.generation && event.busy
              ? { target: "external" }
              : {},
        },
      },
      external: {
        on: {
          SIGNED_IN: ({ context, event }) =>
            event.generation === context.source.generation
              ? { target: "working.changedSession" }
              : {},
          EXTERNAL: ({ context, event }) =>
            event.generation === context.source.generation && !event.busy
              ? { target: "ready" }
              : {},
        },
      },
      failed: {
        on: {
          RETRY: ({ context }) => ({
            target: "working.locate",
            context: {
              ...context,
              source: { ...context.source, token: null },
              error: "",
              reads: 0,
            },
          }),
        },
      },
      unavailable: {},
      welcome: {},
    },
  })
}
