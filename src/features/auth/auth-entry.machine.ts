import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Redacted, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { Secret, authMessage } from "./auth-contracts"

export const EntryKind = Schema.Literals([
  "login",
  "setup",
  "forgot",
  "reset",
  "totp",
  "backup",
  "passkey",
])
export type EntryKind = typeof EntryKind.Type
const Request = Schema.Struct({ kind: EntryKind, secret: Secret })
export type EntryRequest = typeof Request.Type
const Input = Schema.Struct({ kind: EntryKind, error: Schema.String })
const context = Schema.Struct({
  kind: EntryKind,
  request: Schema.NullOr(Request),
  error: Schema.String,
  notice: Schema.String,
  externalBusy: Schema.Boolean,
  failure: Schema.UndefinedOr(Schema.Unknown),
})
export function authEntryMachine(work: {
  request: (input: EntryRequest) => Effect.Effect<void, unknown, Scope.Scope>
  completed: (input: EntryRequest) => Effect.Effect<void, unknown, Scope.Scope>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Input,
      context,
      events: {
        SUBMIT: Schema.Struct({ secret: Secret }),
        MODE: Schema.Struct({ kind: EntryKind }),
        RESET: Schema.Struct({}),
        BUSY: Schema.Struct({ busy: Schema.Boolean }),
      },
    },
    actors: {
      request: createEffectLogic(({ input }: { input: EntryRequest }) =>
        Effect.exit(
          work.request(input).pipe(Effect.andThen(work.completed(input)))
        )
      ),
    },
  }).createMachine({
    id: "auth-entry",
    initial: "form",
    context: ({ input }) => ({
      ...input,
      request: null,
      notice: "",
      externalBusy: false,
      failure: undefined,
    }),
    on: {
      BUSY: ({ context, event }) =>
        context.externalBusy === event.busy
          ? undefined
          : { context: { ...context, externalBusy: event.busy } },
    },
    states: {
      form: {
        on: {
          MODE: ({ context, event }) =>
            context.externalBusy
              ? undefined
              : {
                  context: {
                    ...context,
                    kind: event.kind,
                    error: "",
                    notice: "",
                    failure: undefined,
                  },
                },
          SUBMIT: ({ context, event }) => {
            if (context.externalBusy) return
            const input = Redacted.value(event.secret)
            if (context.kind === "reset" && input.password !== input.confirm)
              return {
                context: { ...context, error: "Your passwords don't match." },
              }
            return {
              target: "requesting",
              context: {
                ...context,
                request: { kind: context.kind, secret: event.secret },
                error: "",
                notice: "",
                failure: undefined,
              },
            }
          },
        },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: (args) => {
            const { context, event } = args
            if (Exit.isFailure(event.output)) {
              const problem = authMessage(
                event.output.cause,
                "Could not confirm the request. Please try again."
              )
              return {
                target: problem.code === "INVALID_TOKEN" ? "invalid" : "form",
                context: {
                  ...context,
                  request: null,
                  error: problem.message,
                  failure: event.output.cause,
                },
              }
            }
            return {
              target: ["setup", "login", "passkey"].includes(context.kind)
                ? "form"
                : "completed",
              context: {
                ...context,
                kind: context.kind === "setup" ? "login" : context.kind,
                request: null,
                notice:
                  context.kind === "setup"
                    ? "Account created. Sign in with your owner email and password."
                    : "",
              },
            }
          },
        },
      },
      completed: {
        on: {
          RESET: ({ context }) => ({
            target: "form",
            context: { ...context, error: "", notice: "" },
          }),
        },
      },
      invalid: {},
    },
  })
}
