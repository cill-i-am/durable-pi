import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Cause, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AppDetail, AppDocument } from "@/apps/contracts"

const Attempt = Schema.Struct({
  path: Schema.String,
  input: Schema.StructWithRest(Schema.Struct({ operationId: Schema.String }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
})
export type AppAttempt = typeof Attempt.Type
const Command = Schema.Union([
  Schema.Struct({ type: Schema.Literal("mutate"), attempt: Attempt }),
  Schema.Struct({ type: Schema.Literals(["retry", "cancel"]) }),
])
export type AppCommand = typeof Command.Type
const Failure = Schema.Struct({
  kind: Schema.Literals(["load", "mutation"]),
  message: Schema.String,
})
const context = Schema.Struct({
  agentId: Schema.String,
  id: Schema.String,
  visible: Schema.Boolean,
  detail: Schema.NullOr(AppDetail),
  attempt: Schema.NullOr(Attempt),
  ticket: Schema.NullOr(Schema.String),
  cancelling: Schema.Boolean,
  applied: Schema.Boolean,
  outcome: Schema.Boolean,
  failure: Schema.NullOr(Failure),
  cause: Schema.Unknown,
})
export type AppWork = {
  read: Effect.Effect<AppDetail, unknown, Scope.Scope>
  mutate: (
    attempt: AppAttempt
  ) => Effect.Effect<AppDocument, unknown, Scope.Scope>
  cancel: (
    attempt: AppAttempt
  ) => Effect.Effect<{ applied: boolean }, unknown, Scope.Scope>
}
const message = (cause: Cause.Cause<unknown>, fallback: string) => {
  const failed = cause.reasons.find((reason) => reason._tag === "Fail")
  return failed?._tag === "Fail" &&
    Schema.is(Schema.Struct({ message: Schema.String }))(failed.error)
    ? failed.error.message
    : fallback
}
export function appUiMachine(work: AppWork) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.Struct({
        agentId: Schema.String,
        id: Schema.String,
        visible: Schema.Boolean,
      }),
      context,
      events: {
        COMMAND: Schema.Struct({ ticket: Schema.String, command: Command }),
        REFRESH: Schema.Struct({}),
        VISIBILITY: Schema.Struct({ visible: Schema.Boolean }),
      },
      emitted: {
        settled: Schema.Struct({ ticket: Schema.String, ok: Schema.Boolean }),
      },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(work.read)),
      mutation: createEffectLogic(
        ({ input }: { input: { attempt: AppAttempt; cancelling: boolean } }) =>
          Effect.exit(
            input.cancelling
              ? work.cancel(input.attempt).pipe(
                  Effect.map(
                    (
                      result
                    ): { document: AppDocument | null; applied: boolean } => ({
                      document: null,
                      applied: result.applied,
                    })
                  )
                )
              : work
                  .mutate(input.attempt)
                  .pipe(
                    Effect.map((document) => ({ document, applied: false }))
                  )
          )
      ),
    },
  }).createMachine({
    id: "app-ui",
    initial: "choosing",
    context: ({ input }) => ({
      ...input,
      detail: null,
      attempt: null,
      ticket: null,
      cancelling: false,
      applied: false,
      outcome: false,
      failure: null,
      cause: undefined,
    }),
    on: {
      VISIBILITY: ({ context, event }) => ({
        context: { ...context, visible: event.visible },
      }),
      REFRESH: { target: ".loading" },
      COMMAND: ({ context, event }, enq) => {
        const attempt =
          context.attempt ??
          (event.command.type === "mutate" ? event.command.attempt : null)
        if (!attempt) {
          enq.emit({ type: "settled", ticket: event.ticket, ok: false })
          return
        }
        return {
          target: ".mutating",
          context: {
            ...context,
            attempt,
            ticket: event.ticket,
            cancelling: event.command.type === "cancel",
            applied: false,
            outcome: false,
            failure: null,
            cause: undefined,
          },
        }
      },
    },
    states: {
      choosing: {
        always: ({ context }) => ({
          target: context.visible ? "loading" : "hidden",
        }),
      },
      hidden: {
        always: ({ context }) =>
          context.visible ? { target: "loading" } : undefined,
      },
      loading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) => ({
            target: "waiting",
            context: Exit.isSuccess(event.output)
              ? {
                  ...context,
                  detail: event.output.value,
                  failure:
                    context.failure?.kind === "mutation"
                      ? context.failure
                      : null,
                }
              : {
                  ...context,
                  failure:
                    context.failure?.kind === "mutation"
                      ? context.failure
                      : {
                          kind: "load",
                          message: message(
                            event.output.cause,
                            "Could not load the app."
                          ),
                        },
                  cause: event.output.cause,
                },
          }),
        },
      },
      waiting: {
        always: ({ context }) =>
          !context.visible ? { target: "hidden" } : undefined,
        after: { 4000: { target: "loading" } },
      },
      mutating: {
        on: {
          REFRESH: {},
          COMMAND: ({ event }, enq) => {
            enq.emit({ type: "settled", ticket: event.ticket, ok: false })
          },
        },
        invoke: {
          src: "mutation",
          input: ({ context }) => ({
            attempt: context.attempt!,
            cancelling: context.cancelling,
          }),
          onDone: ({ context, event }) => ({
            target: "settling",
            context: Exit.isSuccess(event.output)
              ? {
                  ...context,
                  outcome: true,
                  applied: event.output.value.applied,
                  attempt:
                    context.cancelling && event.output.value.applied
                      ? context.attempt
                      : null,
                  detail:
                    event.output.value.document && context.detail
                      ? { ...context.detail, app: event.output.value.document }
                      : context.detail,
                }
              : {
                  ...context,
                  outcome: false,
                  failure: {
                    kind: "mutation",
                    message: context.cancelling
                      ? "Cancellation is unconfirmed. Retry before making a different change."
                      : message(
                          event.output.cause,
                          "The change is unconfirmed. Retry the same request."
                        ),
                  },
                  cause: event.output.cause,
                },
          }),
        },
      },
      settling: {
        on: {
          REFRESH: {},
          COMMAND: ({ event }, enq) => {
            enq.emit({ type: "settled", ticket: event.ticket, ok: false })
          },
        },
        invoke: {
          src: "read",
          onDone: ({ context, event }, enq) => {
            const confirmed = Exit.isSuccess(event.output),
              ok = context.outcome && (!context.applied || confirmed)
            enq.emit({ type: "settled", ticket: context.ticket!, ok })
            return {
              target: "waiting",
              context: {
                ...context,
                ticket: null,
                detail: Exit.isSuccess(event.output)
                  ? event.output.value
                  : context.detail,
                attempt: context.applied && confirmed ? null : context.attempt,
                failure: context.applied
                  ? {
                      kind: "mutation",
                      message: confirmed
                        ? "The previous change was already saved. The latest app is shown."
                        : "Cancellation is unconfirmed. Retry before making a different change.",
                    }
                  : (context.failure ??
                    (confirmed
                      ? null
                      : {
                          kind: "load",
                          message: "Could not reload the app.",
                        })),
                cause: Exit.isFailure(event.output)
                  ? event.output.cause
                  : context.cause,
              },
            }
          },
        },
      },
    },
  })
}
