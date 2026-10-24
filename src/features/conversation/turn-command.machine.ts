import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import type { AnyActorRef } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export const TurnCommand = Schema.Struct({
  action: Schema.Literals(["retry", "cancel"]),
  turnId: Schema.String,
  operationId: Schema.String,
})
export type TurnCommand = typeof TurnCommand.Type
const context = Schema.Struct({
  request: Schema.NullOr(TurnCommand),
  attempts: Schema.Record(Schema.String, Schema.String),
  error: Schema.String,
  failure: Schema.Unknown,
  cancellations: Schema.Array(Schema.String),
  cancelFailures: Schema.Record(Schema.String, Schema.Unknown),
})
const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)

/** Retry admission is serial; each explicit Stop independently owns its native
 * request so an uncertain retry acknowledgement cannot withhold cancellation. */
export function turnCommandMachine(
  request: (input: TurnCommand) => Effect.Effect<void, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context,
      events: {
        RETRY: Schema.Struct({
          turnId: Schema.String,
          allowed: Schema.Boolean,
        }),
        CANCEL: Schema.Struct({ turnId: Schema.String }),
        CANCEL_DONE: Schema.Struct({ turnId: Schema.String, outcome }),
        CLEAR_ERROR: Schema.Struct({}),
      },
    },
    actions: {
      cancel: ({ params, self }: { params?: unknown; self: AnyActorRef }) => {
        const input = Schema.decodeUnknownSync(TurnCommand)(params)
        return Effect.exit(request(input)).pipe(
          Effect.tap((outcome) =>
            Effect.sync(() =>
              self.send({ type: "CANCEL_DONE", turnId: input.turnId, outcome })
            )
          )
        )
      },
    },
    actors: {
      request: createEffectLogic(({ input }: { input: TurnCommand }) =>
        Effect.exit(request(input))
      ),
    },
  }).createMachine({
    id: "conversation-turn-command",
    initial: "ready",
    context: {
      request: null,
      attempts: {},
      error: "",
      failure: undefined,
      cancellations: [],
      cancelFailures: {},
    },
    on: {
      CLEAR_ERROR: ({ context }) => ({ context: { ...context, error: "" } }),
      CANCEL: (args, enq) => {
        const { context, event } = args
        if (context.cancellations.includes(event.turnId)) return
        enq(args.actions.cancel, {
          ...args,
          params: {
            action: "cancel",
            turnId: event.turnId,
            operationId: event.turnId,
          },
        })
        return {
          context: {
            ...context,
            cancellations: [...context.cancellations, event.turnId],
          },
        }
      },
      CANCEL_DONE: ({ context, event }) => {
        const failure = Exit.isFailure(event.outcome)
          ? event.outcome.cause
          : undefined
        return {
          context: {
            ...context,
            cancellations: context.cancellations.filter(
              (id) => id !== event.turnId
            ),
            cancelFailures: {
              ...context.cancelFailures,
              [event.turnId]: failure,
            },
            error: failure
              ? "Could not stop the turn. Try again."
              : context.error,
          },
        }
      },
    },
    states: {
      ready: {
        on: {
          RETRY: ({ context, event }) => {
            if (!event.allowed) return
            const operationId =
              context.attempts[event.turnId] ?? crypto.randomUUID()
            return {
              target: "requesting",
              context: {
                ...context,
                error: "",
                failure: undefined,
                attempts: { ...context.attempts, [event.turnId]: operationId },
                request: {
                  action: "retry" as const,
                  turnId: event.turnId,
                  operationId,
                },
              },
            }
          },
        },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => {
            const attempts = { ...context.attempts }
            if (
              Exit.isSuccess(event.output) &&
              context.request?.action === "retry"
            )
              delete attempts[context.request.turnId]
            const failure = Exit.isFailure(event.output)
              ? event.output.cause
              : undefined
            const first = failure?.reasons[0]
            const error = first?._tag === "Fail" ? first.error : failure
            const message = Schema.decodeUnknownOption(
              Schema.Struct({ message: Schema.String })
            )(error)
            return {
              target: "ready",
              context: {
                ...context,
                attempts,
                failure,
                error: error
                  ? message._tag === "Some"
                    ? message.value.message
                    : context.request?.action === "retry"
                      ? "Could not retry."
                      : "Could not stop the turn. Try again."
                  : context.error,
              },
            }
          },
        },
      },
    },
  })
}
