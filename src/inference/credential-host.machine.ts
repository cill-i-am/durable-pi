import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import type {
  AccountCredentialError,
  ModelCredential,
} from "./credential-domain"

export interface CredentialWork {
  readonly id: string
  readonly kind: "rotate" | "connect" | "install"
  readonly run: Effect.Effect<
    ModelCredential | undefined,
    AccountCredentialError
  >
  readonly result: Deferred.Deferred<
    ModelCredential | undefined,
    AccountCredentialError
  >
}
const work = Schema.declare(
  (value): value is CredentialWork =>
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    "kind" in value &&
    (value.kind === "rotate" ||
      value.kind === "connect" ||
      value.kind === "install") &&
    "run" in value &&
    Effect.isEffect(value.run) &&
    "result" in value &&
    Deferred.isDeferred(value.result)
)
const failure = Schema.declare(
  (value): value is Cause.Cause<AccountCredentialError> => Cause.isCause(value)
)
export const credentialHostMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      work: Schema.UndefinedOr(work),
      failure: Schema.UndefinedOr(failure),
      lastId: Schema.String,
    }),
    events: { ACCEPT: Schema.Struct({ work }), CLOSE: Schema.Struct({}) },
  },
  actors: {
    work: createEffectLogic(({ input }: { input: CredentialWork }) =>
      Effect.exit(
        input.run.pipe(
          Effect.onExit((exit) => Deferred.done(input.result, exit))
        )
      )
    ),
  },
}).createMachine({
  id: "credential-host",
  context: () => ({
    work: undefined as CredentialWork | undefined,
    failure: undefined as Cause.Cause<AccountCredentialError> | undefined,
    lastId: "",
  }),
  initial: "ready",
  on: { CLOSE: { target: ".closing" } },
  states: {
    ready: {
      on: {
        ACCEPT: ({ event }) => ({
          target:
            event.work.kind === "rotate"
              ? "rotating"
              : event.work.kind === "connect"
                ? "connecting"
                : "installing",
          context: {
            work: event.work,
            failure: undefined,
            lastId: event.work.id,
          },
        }),
      },
    },
    failed: {
      on: {
        ACCEPT: ({ event }) =>
          event.work.kind !== "rotate"
            ? {
                target:
                  event.work.kind === "connect" ? "connecting" : "installing",
                context: {
                  work: event.work,
                  failure: undefined,
                  lastId: event.work.id,
                },
              }
            : undefined,
      },
    },
    rotating: {
      invoke: {
        src: "work",
        input: ({ context }) => context.work!,
        onDone: ({ context, event }) => ({
          target:
            Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
              ? "failed"
              : "ready",
          context: {
            ...context,
            work: undefined,
            failure:
              Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
                ? event.output.cause
                : undefined,
          },
        }),
      },
    },
    connecting: {
      invoke: {
        src: "work",
        input: ({ context }) => context.work!,
        onDone: ({ context, event }) => ({
          target:
            Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
              ? "failed"
              : "ready",
          context: {
            ...context,
            work: undefined,
            failure:
              Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
                ? event.output.cause
                : undefined,
          },
        }),
      },
    },
    installing: {
      invoke: {
        src: "work",
        input: ({ context }) => context.work!,
        onDone: ({ context, event }) => ({
          target:
            Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
              ? "failed"
              : "ready",
          context: {
            ...context,
            work: undefined,
            failure:
              Exit.isFailure(event.output) && Cause.hasDies(event.output.cause)
                ? event.output.cause
                : undefined,
          },
        }),
      },
    },
    closing: {},
  },
})
