import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Exit, Random, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { observeCleanup, preserveFatal } from "../shared/effect"
import {
  Delivery,
  Receipt,
  failure,
  type CommunicationError,
} from "./contracts"
import type { Mailbox, MailboxTransport } from "./mailbox"

type DeliveryMailbox = Pick<
  Mailbox["Service"],
  "expire" | "claimDelivery" | "delivered" | "deliveryFailed"
>

/** One scoped transport attempt. The mailbox owns the durable retry budget,
 * deadline, receipt and attempt fence; this actor cannot authorize a new send. */
export function deliveryMachine(
  mailbox: DeliveryMailbox,
  transport: Pick<MailboxTransport["Service"], "deliver">
) {
  const outcome = Schema.declare(
    (value): value is Exit.Exit<boolean, CommunicationError> =>
      Exit.isExit(value)
  )
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        delivery: Schema.NullOr(
          Schema.declare((value): value is Delivery =>
            Schema.is(Delivery)(value)
          )
        ),
        receipt: Schema.NullOr(Receipt),
        permanent: Schema.Boolean,
        outcome,
      }),
      output: outcome,
    },
    actors: {
      expire: createEffectLogic(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(mailbox.expire),
          Effect.exit
        )
      ),
      claim: createEffectLogic(
        Clock.currentTimeMillis.pipe(
          Effect.flatMap(mailbox.claimDelivery),
          Effect.exit
        )
      ),
      send: createEffectLogic(({ input }: { input: Delivery }) =>
        observeCleanup(
          Effect.suspend(() => transport.deliver(input.envelope)),
          (observed) => observed.pipe(Effect.timeout("10 seconds"))
        ).pipe(
          preserveFatal,
          Effect.catchTag("TimeoutError", () =>
            Effect.fail(
              failure("transport", "Delivery acknowledgement timed out.")
            )
          ),
          preserveFatal,
          Effect.result,
          Effect.exit
        )
      ),
      acknowledge: createEffectLogic(
        ({ input }: { input: { delivery: Delivery; receipt: Receipt } }) =>
          mailbox
            .delivered(
              input.delivery.envelope.id,
              input.delivery.attempts,
              input.receipt
            )
            .pipe(Effect.exit)
      ),
      reject: createEffectLogic(
        ({ input }: { input: { delivery: Delivery; permanent: boolean } }) =>
          Effect.gen(function* () {
            const jitter = yield* Random.next
            const delay = Math.round(
              Math.min(60000, 1000 * 2 ** (input.delivery.attempts - 1)) *
                (0.75 + jitter / 2)
            )
            yield* mailbox.deliveryFailed(
              input.delivery.envelope.id,
              input.delivery.attempts,
              yield* Clock.currentTimeMillis,
              delay,
              input.permanent
            )
          }).pipe(Effect.exit)
      ),
    },
  }).createMachine({
    id: "communication-delivery",
    context: () => ({
      delivery: null,
      receipt: null,
      permanent: false,
      outcome: Exit.succeed(false) as Exit.Exit<boolean, CommunicationError>,
    }),
    output: ({ context }) => context.outcome,
    initial: "expiring",
    states: {
      expiring: {
        invoke: {
          src: "expire",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "settled",
                  context: {
                    ...context,
                    outcome: Exit.failCause(event.output.cause),
                  },
                }
              : { target: "claiming" },
        },
      },
      claiming: {
        invoke: {
          src: "claim",
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            if (!event.output.value) return { target: "settled" }
            return {
              target: "sending",
              context: {
                ...context,
                delivery: event.output.value,
                outcome: Exit.succeed(true),
              },
            }
          },
        },
      },
      sending: {
        invoke: {
          src: "send",
          input: ({ context }) => context.delivery!,
          onDone: ({ context, event }) => {
            if (Exit.isFailure(event.output))
              return {
                target: "settled",
                context: {
                  ...context,
                  outcome: Exit.failCause(event.output.cause),
                },
              }
            const result = event.output.value
            return result._tag === "Success"
              ? {
                  target: "acknowledging",
                  context: { ...context, receipt: result.success },
                }
              : {
                  target: "rejecting",
                  context: {
                    ...context,
                    permanent: [
                      "invalid",
                      "forbidden",
                      "conflict",
                      "expired",
                    ].includes(result.failure.code),
                  },
                }
          },
        },
      },
      acknowledging: {
        invoke: {
          src: "acknowledge",
          input: ({ context }) => ({
            delivery: context.delivery!,
            receipt: context.receipt!,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : context.outcome,
            },
          }),
        },
      },
      rejecting: {
        invoke: {
          src: "reject",
          input: ({ context }) => ({
            delivery: context.delivery!,
            permanent: context.permanent,
          }),
          onDone: ({ context, event }) => ({
            target: "settled",
            context: {
              ...context,
              outcome: Exit.isFailure(event.output)
                ? Exit.failCause(event.output.cause)
                : context.outcome,
            },
          }),
        },
      },
      settled: { type: "final" },
    },
  })
}
