import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export interface PreparedWebhook {
  id: string
  keyHash: string
  eventId: string
  payload: string
  hash: string
}
export interface WebhookAcceptance {
  runId: string
  duplicate: boolean
}
interface Context<E> {
  prepared: PreparedWebhook | undefined
  deadline: number
  accepted: WebhookAcceptance | undefined
  outcome: Exit.Exit<WebhookAcceptance, E> | undefined
}

/** A request owns preparation and acknowledgements. The committed receipt and
 * prearmed discovery outlive this scope and never depend on caller attendance. */
export function webhookIngressMachine<E, R>(work: {
  prepare: Effect.Effect<PreparedWebhook, E, R>
  arm: Effect.Effect<number, E, R>
  accept: (
    prepared: PreparedWebhook,
    deadline: number
  ) => Effect.Effect<WebhookAcceptance, E, R>
  acknowledge: Effect.Effect<unknown, E, R>
}) {
  type C = Context<E>
  const contextSchema = Schema.declare(
    (value): value is C =>
      typeof value === "object" && value !== null && "deadline" in value
  )
  const outcome = Schema.declare(
    (value): value is Exit.Exit<WebhookAcceptance, E> => Exit.isExit(value)
  )
  const failed = (context: C, cause: Exit.Failure<unknown, E>) => ({
    target: "settled",
    context: { ...context, outcome: Exit.failCause(cause.cause) },
  })
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: contextSchema, output: outcome },
    actors: {
      prepare: createEffectLogic(Effect.exit(work.prepare)),
      arm: createEffectLogic(Effect.exit(work.arm)),
      accept: createEffectLogic(({ input }: { input: C }) =>
        Effect.exit(
          Effect.uninterruptible(work.accept(input.prepared!, input.deadline))
        )
      ),
      acknowledge: createEffectLogic(Effect.exit(work.acknowledge)),
    },
  }).createMachine({
    id: "webhook-ingress",
    initial: "preparing",
    context: (): C => ({
      prepared: undefined,
      deadline: 0,
      accepted: undefined,
      outcome: undefined,
    }),
    output: ({ context }) => context.outcome!,
    states: {
      preparing: {
        invoke: {
          src: "prepare",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "arming",
                  context: { ...context, prepared: event.output.value },
                },
        },
      },
      arming: {
        invoke: {
          src: "arm",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "accepting",
                  context: { ...context, deadline: event.output.value },
                },
        },
      },
      accepting: {
        invoke: {
          src: "accept",
          input: ({ context }) => context,
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "acknowledging",
                  context: { ...context, accepted: event.output.value },
                },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? failed(context, event.output)
              : {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.succeed(context.accepted!),
                  },
                },
        },
      },
      settled: { type: "final" },
    },
  })
}
