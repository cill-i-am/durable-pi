import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { authMessage } from "./auth-contracts"

export const SavedPasskey = Schema.Struct({
  id: Schema.String,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  createdAt: Schema.optional(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Date]))
  ),
})
export type Passkey = typeof SavedPasskey.Type
const Editor = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add") }),
  Schema.Struct({
    kind: Schema.Literals(["rename", "remove"]),
    key: SavedPasskey,
  }),
])
export type PasskeyEditor = typeof Editor.Type
const Request = Schema.Struct({ editor: Editor, name: Schema.String })
export type PasskeyRequest = typeof Request.Type
export type PasskeyWork = {
  read: () => Effect.Effect<readonly Passkey[], unknown, Scope.Scope>
  save: (input: PasskeyRequest) => Effect.Effect<void, unknown, Scope.Scope>
  signOut: () => Effect.Effect<void, unknown, Scope.Scope>
}
function requiresRefresh(code: string | undefined) {
  return ![
    "SESSION_NOT_FRESH",
    "UNAUTHORIZED",
    "PASSKEY_DEVICE_VERIFICATION_REQUIRED",
    "REGISTRATION_CANCELLED",
    "ERROR_CEREMONY_ABORTED",
    "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED",
  ].includes(code ?? "")
}
export function passkeysMachine(work: PasskeyWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        disabled: Schema.Boolean,
        available: Schema.Boolean,
      }),
      context: Schema.Struct({
        keys: Schema.Array(SavedPasskey),
        editor: Schema.NullOr(Editor),
        request: Schema.NullOr(Request),
        disabled: Schema.Boolean,
        available: Schema.Boolean,
        error: Schema.String,
        notice: Schema.String,
        freshSignIn: Schema.Boolean,
        readFailed: Schema.Boolean,
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: {
        VIEW: Schema.Struct({
          disabled: Schema.Boolean,
          available: Schema.Boolean,
        }),
        EDIT: Schema.Struct({ editor: Editor }),
        CANCEL: Schema.Struct({}),
        SAVE: Schema.Struct({ name: Schema.String }),
        REFRESH: Schema.Struct({}),
        SIGN_OUT: Schema.Struct({}),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read())),
      save: createEffectLogic(({ input }: { input: PasskeyRequest }) =>
        Effect.exit(work.save(input))
      ),
      signOut: createEffectLogic(() => Effect.exit(work.signOut())),
    },
  }).createMachine({
    id: "auth-passkeys",
    initial: "loading",
    context: ({ input }) => ({
      ...input,
      keys: [],
      editor: null,
      request: null,
      error: "",
      notice: "",
      freshSignIn: false,
      readFailed: false,
      failure: undefined,
    }),
    on: {
      VIEW: ({ context, event }) =>
        context.disabled === event.disabled &&
        context.available === event.available
          ? undefined
          : {
              context: {
                ...context,
                disabled: event.disabled,
                available: event.available,
              },
            },
    },
    states: {
      loading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "ready",
                  context: {
                    ...context,
                    keys: [],
                    readFailed: true,
                    error:
                      "Could not load passkeys. Refresh the list before making changes.",
                    failure: event.output.cause,
                  },
                }
              : {
                  target: "ready",
                  context: {
                    ...context,
                    keys: event.output.value,
                    readFailed: false,
                    error: "",
                    freshSignIn: false,
                    failure: undefined,
                  },
                },
        },
      },
      ready: {
        on: {
          EDIT: ({ context, event }) => {
            if (
              context.disabled ||
              context.readFailed ||
              (event.editor.kind === "add"
                ? !context.available
                : !context.keys.some(
                    (key) =>
                      event.editor.kind !== "add" &&
                      key.id === event.editor.key.id
                  ))
            )
              return
            return {
              context: {
                ...context,
                editor: event.editor,
                error: "",
                notice: "",
                freshSignIn: false,
              },
            }
          },
          CANCEL: ({ context }) =>
            context.disabled
              ? undefined
              : { context: { ...context, editor: null } },
          REFRESH: ({ context }) =>
            context.disabled
              ? undefined
              : {
                  target: "loading",
                  context: { ...context, editor: null, error: "" },
                },
          SAVE: ({ context, event }) =>
            !context.editor ||
            context.disabled ||
            context.readFailed ||
            (context.editor.kind !== "remove" && !event.name.trim())
              ? undefined
              : {
                  target: "saving",
                  context: {
                    ...context,
                    request: {
                      editor: context.editor,
                      name: event.name.trim(),
                    },
                    error: "",
                    notice: "",
                    failure: undefined,
                  },
                },
          SIGN_OUT: ({ context }) =>
            !context.disabled && context.freshSignIn
              ? { target: "signingOut" }
              : undefined,
        },
      },
      saving: {
        invoke: {
          src: "save",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output)) {
              const problem = authMessage(
                event.output.cause,
                "Could not confirm the change. Refresh the list before trying again."
              )
              return {
                target: "ready",
                context: {
                  ...context,
                  request: null,
                  error: problem.message,
                  freshSignIn: problem.code === "SESSION_NOT_FRESH",
                  readFailed: requiresRefresh(problem.code),
                  failure: event.output.cause,
                },
              }
            }
            const kind = context.request!.editor.kind
            return {
              target: "loading",
              context: {
                ...context,
                editor: null,
                request: null,
                notice:
                  kind === "add"
                    ? "Passkey added. You can use it next time you sign in."
                    : kind === "rename"
                      ? "Passkey renamed."
                      : "Passkey removed. Existing browser sessions stay signed in.",
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
                  context: { ...context, keys: [], editor: null },
                },
        },
      },
      signedOut: {},
    },
  })
}
