import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { authMessage } from "./auth-contracts"

export const BrowserSession = Schema.Struct({
  id: Schema.String,
  token: Schema.Redacted(Schema.String, { disallowJsonEncode: true }),
  createdAt: Schema.Date,
  expiresAt: Schema.Date,
  userAgent: Schema.optional(Schema.NullOr(Schema.String)),
})
export type BrowserSession = typeof BrowserSession.Type
const Confirmation = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("others") }),
  Schema.Struct({ kind: Schema.Literal("one"), session: BrowserSession }),
])
export type SecurityConfirmation = typeof Confirmation.Type
const Context = Schema.Struct({
  currentId: Schema.String,
  sessions: Schema.Array(BrowserSession),
  confirm: Schema.NullOr(Confirmation),
  factorView: Schema.Boolean,
  factorBusy: Schema.Boolean,
  passkeyBusy: Schema.Boolean,
  error: Schema.String,
  notice: Schema.String,
  freshSignIn: Schema.Boolean,
  readFailed: Schema.Boolean,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
const childBusy = (context: typeof Context.Type) =>
  context.factorBusy || context.passkeyBusy
export type SecurityWork = {
  read: () => Effect.Effect<readonly BrowserSession[], unknown, Scope.Scope>
  revoke: (
    input: SecurityConfirmation
  ) => Effect.Effect<void, unknown, Scope.Scope>
  signOut: () => Effect.Effect<void, unknown, Scope.Scope>
  close: () => Effect.Effect<void>
}
export function securityMachine(work: SecurityWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({ currentId: Schema.String }),
      context: Context,
      events: {
        CHILD_BUSY: Schema.Struct({
          child: Schema.Literals(["factor", "passkey"]),
          busy: Schema.Boolean,
        }),
        FACTOR: Schema.Struct({ open: Schema.Boolean }),
        ASK: Schema.Struct({ confirmation: Confirmation }),
        CANCEL: Schema.Struct({}),
        REVOKE: Schema.Struct({}),
        REFRESH: Schema.Struct({}),
        SIGN_OUT: Schema.Struct({}),
        CLOSE: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      revoke: createEffectLogic(({ input }: { input: SecurityConfirmation }) =>
        Effect.exit(work.revoke(input))
      ),
      signOut: createEffectLogic(() => Effect.exit(work.signOut())),
    },
    actions: { close: (_args: object) => work.close() },
  }).createMachine({
    id: "account-security",
    initial: "loading",
    context: ({ input }) => ({
      ...input,
      sessions: [],
      confirm: null,
      factorView: false,
      factorBusy: false,
      passkeyBusy: false,
      error: "",
      notice: "",
      freshSignIn: false,
      readFailed: false,
      failure: undefined,
    }),
    on: {
      CHILD_BUSY: ({ context, event }) => ({
        context:
          event.child === "factor"
            ? { ...context, factorBusy: event.busy }
            : { ...context, passkeyBusy: event.busy },
      }),
    },
    states: {
      loading: {
        on: {
          CLOSE: (args, enq) => {
            if (!childBusy(args.context)) enq(args.actions.close, args)
          },
        },
        invoke: {
          src: "read",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output)) {
              const problem = authMessage(
                event.output.cause,
                "Could not load browser sessions. Try refreshing."
              )
              return {
                target: "ready",
                context: {
                  ...context,
                  sessions: [],
                  error: problem.message,
                  freshSignIn: problem.code === "SESSION_NOT_FRESH",
                  readFailed: true,
                  failure: event.output.cause,
                },
              }
            }
            return {
              target: "ready",
              context: {
                ...context,
                sessions: event.output.value,
                readFailed: false,
                error: "",
                freshSignIn: false,
                failure: undefined,
              },
            }
          },
        },
      },
      ready: {
        on: {
          FACTOR: ({ context, event }) =>
            event.open && childBusy(context)
              ? undefined
              : {
                  target: event.open ? "ready" : "loading",
                  context: {
                    ...context,
                    factorView: event.open,
                    confirm: null,
                    factorBusy: false,
                  },
                },
          ASK: ({ context, event }) => {
            if (childBusy(context) || context.factorView || context.readFailed)
              return
            if (event.confirmation.kind === "others")
              return {
                context: {
                  ...context,
                  confirm: event.confirmation,
                  error: "",
                  notice: "",
                },
              }
            const id = event.confirmation.session.id
            const session = context.sessions.find((value) => value.id === id)
            if (!session || id === context.currentId) return
            return {
              context: {
                ...context,
                confirm: { kind: "one", session },
                error: "",
                notice: "",
              },
            }
          },
          CANCEL: ({ context }) =>
            childBusy(context)
              ? undefined
              : { context: { ...context, confirm: null } },
          REVOKE: ({ context }) =>
            childBusy(context) ||
            context.factorView ||
            context.readFailed ||
            !context.confirm
              ? undefined
              : {
                  target: "revoking",
                  context: {
                    ...context,
                    error: "",
                    notice: "",
                    failure: undefined,
                  },
                },
          REFRESH: ({ context }) =>
            childBusy(context)
              ? undefined
              : {
                  target: "loading",
                  context: { ...context, confirm: null, error: "" },
                },
          SIGN_OUT: ({ context }) =>
            childBusy(context) || !context.freshSignIn
              ? undefined
              : { target: "signingOut" },
          CLOSE: (args, enq) => {
            if (!childBusy(args.context)) enq(args.actions.close, args)
          },
        },
      },
      revoking: {
        invoke: {
          src: "revoke",
          input: ({ context }) => context.confirm!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output)) {
              const problem = authMessage(
                event.output.cause,
                "Could not confirm revocation. Refresh the list before trying again."
              )
              return {
                target: "ready",
                context: {
                  ...context,
                  error: problem.message,
                  freshSignIn: problem.code === "SESSION_NOT_FRESH",
                  readFailed:
                    problem.code !== "SESSION_NOT_FRESH" &&
                    problem.code !== "UNAUTHORIZED",
                  failure: event.output.cause,
                },
              }
            }
            return {
              target: "loading",
              context: {
                ...context,
                confirm: null,
                notice:
                  "Browser access revoked. Open connections close within one minute.",
              },
            }
          },
        },
      },
      signingOut: {
        invoke: {
          src: "signOut",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    error: "Could not confirm sign-out. Try again.",
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "signedOut",
                  context: { ...context, sessions: [], confirm: null },
                },
        },
      },
      signedOut: {},
    },
  })
}
