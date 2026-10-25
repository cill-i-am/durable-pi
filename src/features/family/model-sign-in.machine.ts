import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Redacted, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export const ModelSignInPending = Schema.Struct({
  id: Schema.String,
  email: Schema.String,
  expiresAt: Schema.Number,
  authorizationUrl: Schema.String,
})
export type ModelSignInPending = typeof ModelSignInPending.Type
export type SignInResult<T> =
  | { ok: true; value: T; now: number }
  | { ok: false; error: string; now: number }
const address = Schema.declare((value): value is Redacted.Redacted<string> =>
  Redacted.isRedacted(value)
)
const context = Schema.Struct({
  attempt: Schema.NullOr(ModelSignInPending),
  email: Schema.String,
  address: Schema.NullOr(address),
  error: Schema.String,
  requestError: Schema.Boolean,
  connected: Schema.String,
  now: Schema.Number,
})
const expired = "This sign-in has expired or was already used. Start again."

export function modelSignInMachine(ports: {
  restore: Effect.Effect<SignInResult<ModelSignInPending | null>>
  start: (email: string) => Effect.Effect<SignInResult<ModelSignInPending>>
  finish: (
    id: string,
    address: Redacted.Redacted<string>
  ) => Effect.Effect<SignInResult<string>>
  cancel: Effect.Effect<SignInResult<void>>
  connected: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context,
      events: {
        START: Schema.Struct({ email: Schema.String }),
        FINISH: Schema.Struct({ address }),
        CANCEL: Schema.Struct({}),
        AGAIN: Schema.Struct({}),
        EDIT: Schema.Struct({}),
      },
    },
    actors: {
      restore: createEffectLogic(() => ports.restore),
      start: createEffectLogic(({ input }: { input: { email: string } }) =>
        ports.start(input.email)
      ),
      finish: createEffectLogic(
        ({
          input,
        }: {
          input: { id: string; address: Redacted.Redacted<string> }
        }) => ports.finish(input.id, input.address)
      ),
      cancel: createEffectLogic(() => ports.cancel),
      connected: createEffectLogic(() => ports.connected),
    },
    delays: {
      expiry: ({ context }) =>
        Math.max(0, (context.attempt?.expiresAt ?? context.now) - context.now),
    },
  }).createMachine({
    id: "model-sign-in",
    context: {
      attempt: null,
      email: "",
      address: null,
      error: "",
      requestError: false,
      connected: "",
      now: 0,
    },
    initial: "restoring",
    states: {
      restoring: {
        invoke: {
          src: "restore",
          onDone: ({ context, event }) => {
            const result = event.output
            if (!result.ok)
              return {
                target: "idle",
                context: {
                  ...context,
                  now: result.now,
                  error:
                    "Could not restore the previous sign-in. Start again to reconnect.",
                },
              }
            const attempt = result.value
            return {
              target: attempt
                ? attempt.expiresAt <= result.now
                  ? "expired"
                  : "waiting"
                : "idle",
              context: {
                ...context,
                attempt,
                now: result.now,
                error:
                  attempt && attempt.expiresAt <= result.now ? expired : "",
              },
            }
          },
        },
      },
      idle: {
        on: {
          EDIT: ({ context }) => ({
            context: { ...context, error: "", requestError: false },
          }),
          START: ({ context, event }) => ({
            target: "starting",
            context: {
              ...context,
              email: event.email,
              error: "",
              requestError: false,
              connected: "",
            },
          }),
        },
      },
      starting: {
        invoke: {
          src: "start",
          input: ({ context }) => ({ email: context.email }),
          onDone: ({ context, event }) => {
            const result = event.output
            return result.ok
              ? {
                  target:
                    result.value.expiresAt <= result.now
                      ? "expired"
                      : "waiting",
                  context: {
                    ...context,
                    attempt: result.value,
                    now: result.now,
                    error: result.value.expiresAt <= result.now ? expired : "",
                  },
                }
              : {
                  target: "idle",
                  context: {
                    ...context,
                    now: result.now,
                    error: result.error,
                    requestError: true,
                  },
                }
          },
        },
      },
      waiting: {
        after: {
          expiry: ({ context }) => ({
            target: "expired",
            context: { ...context, error: expired },
          }),
        },
        on: {
          FINISH: ({ context, event }) => ({
            target: "exchanging",
            context: {
              ...context,
              address: event.address,
              error: "",
              requestError: false,
            },
          }),
          CANCEL: ({ context }) => ({
            target: "cancelling",
            context: { ...context, requestError: false },
          }),
          EDIT: ({ context }) => ({
            context: { ...context, error: "", requestError: false },
          }),
        },
      },
      exchanging: {
        invoke: {
          src: "finish",
          input: ({ context }) => ({
            id: context.attempt!.id,
            address: context.address!,
          }),
          onDone: ({ context, event }) => {
            const result = event.output
            return result.ok
              ? {
                  target: "connected",
                  context: {
                    ...context,
                    attempt: null,
                    address: null,
                    error: "",
                    requestError: false,
                    connected: result.value,
                    now: result.now,
                  },
                }
              : {
                  target: "reconciling",
                  context: {
                    ...context,
                    address: null,
                    error: result.error,
                    requestError: true,
                    now: result.now,
                  },
                }
          },
        },
      },
      reconciling: {
        invoke: {
          src: "restore",
          onDone: ({ context, event }) => {
            const result = event.output
            const same =
              result.ok &&
              result.value?.id === context.attempt?.id &&
              result.value !== null &&
              result.value.expiresAt > result.now
            return {
              target: same ? "waiting" : "expired",
              context: {
                ...context,
                now: result.now,
                error: same ? context.error : expired,
              },
            }
          },
        },
      },
      expired: {
        on: {
          CANCEL: ({ context }) => ({
            target: "cancelling",
            context: { ...context, requestError: false },
          }),
          EDIT: ({ context }) => ({
            context: { ...context, requestError: false },
          }),
        },
      },
      cancelling: {
        invoke: {
          src: "cancel",
          onDone: ({ context, event }) =>
            event.output.ok
              ? {
                  target: "cancelled",
                  context: {
                    ...context,
                    attempt: null,
                    address: null,
                    error: "",
                    requestError: false,
                  },
                }
              : {
                  target: "expired",
                  context: {
                    ...context,
                    address: null,
                    error: "Could not reset sign-in. Try again.",
                    requestError: true,
                  },
                },
        },
      },
      cancelled: {
        on: {
          START: ({ context, event }) => ({
            target: "starting",
            context: {
              ...context,
              email: event.email,
              error: "",
              requestError: false,
              connected: "",
            },
          }),
        },
      },
      connected: {
        initial: "notifying",
        states: {
          notifying: {
            invoke: { src: "connected", onDone: { target: "ready" } },
          },
          ready: {},
        },
        on: {
          AGAIN: ({ context }) => ({
            target: "idle",
            context: { ...context, connected: "" },
          }),
        },
      },
    },
  })
}
