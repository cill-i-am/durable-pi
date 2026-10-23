import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { ControlUnconfirmed, RecoveryInput } from "@/conversations/contracts"

export const RecoveryControlView = Schema.Struct({
  ...RecoveryInput.fields,
  unconfirmed: ControlUnconfirmed,
  busy: Schema.Boolean,
})
export type RecoveryControlView = typeof RecoveryControlView.Type
export const RecoveryRequest = Schema.Struct({
  ...RecoveryInput.fields,
  action: Schema.Literals(["check", "stop"]),
})
export type RecoveryRequest = typeof RecoveryRequest.Type
const outcome = Schema.declare((value): value is Exit.Exit<void, unknown> =>
  Exit.isExit(value)
)
const context = Schema.Struct({
  view: RecoveryControlView,
  request: Schema.NullOr(RecoveryRequest),
  outcome: Schema.UndefinedOr(outcome),
})
type Context = typeof context.Type

const submit = (context: Context, event: RecoveryRequest) => {
  if (
    context.view.busy ||
    !context.view.unconfirmed ||
    event.operationId !== context.view.operationId ||
    event.revision !== context.view.revision ||
    (event.action === "stop" && context.view.unconfirmed !== "stop")
  )
    return
  return {
    target: "requesting" as const,
    context: {
      ...context,
      request: Schema.decodeUnknownSync(RecoveryRequest)(event),
      outcome: undefined,
    },
  }
}

/** One explicit recovery request; it never creates a reply or retries itself. */
export function recoveryControlsMachine(
  request: (input: RecoveryRequest) => Effect.Effect<void, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: RecoveryControlView,
      context,
      events: { SUBMIT: RecoveryRequest, VIEW: RecoveryControlView },
    },
    actors: {
      request: createEffectLogic(({ input }: { input: RecoveryRequest }) =>
        Effect.exit(request(input))
      ),
    },
  }).createMachine({
    id: "conversation-recovery-controls",
    initial: "ready",
    context: ({ input }) => ({
      view: input,
      request: null,
      outcome: undefined,
    }),
    on: {
      VIEW: ({ context, event }) =>
        event.operationId === context.view.operationId &&
        event.revision >= context.view.revision
          ? {
              context: {
                ...context,
                view: Schema.decodeUnknownSync(RecoveryControlView)(event),
              },
            }
          : undefined,
    },
    states: {
      ready: {
        on: { SUBMIT: ({ context, event }) => submit(context, event) },
      },
      requesting: {
        invoke: {
          src: "request",
          input: ({ context }) => context.request!,
          onDone: ({ context, event }) => ({
            target: "settled",
            context: { ...context, outcome: event.output },
          }),
        },
      },
      settled: {
        // The acknowledgement is not a newer server snapshot. Keep success
        // disabled until the authoritative revision/uncertainty changes.
        always: ({ context }) =>
          context.view.revision !== context.request?.revision ||
          !context.view.unconfirmed
            ? { target: "ready" }
            : undefined,
        on: {
          SUBMIT: ({ context, event }) =>
            context.outcome && Exit.isFailure(context.outcome)
              ? submit(context, event)
              : undefined,
        },
      },
    },
  })
}
