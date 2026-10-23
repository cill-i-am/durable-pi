import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  Delivery,
  LEASE_MS,
  MAX_ATTEMPTS,
  Receipt,
  failure,
  type Envelope,
} from "./contracts"

const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const { status: Status, ...fields } = Delivery.fields
const Context = Schema.toType(Schema.Struct(fields))
type Context = typeof Context.Type
const Claim = Schema.Struct({ now: counter })
const Failed = Schema.Struct({
  attempt: counter,
  now: counter,
  delay: counter,
  permanent: Schema.Boolean,
})

const claim = ({
  context,
  event,
}: {
  context: Context
  event: typeof Claim.Type
}) => {
  if (context.nextAt === null || context.nextAt > event.now) return
  if (
    context.envelope.deadline <= event.now ||
    context.attempts >= context.attemptLimit
  )
    return {
      target: context.envelope.deadline <= event.now ? "expired" : "failed",
      context: {
        ...context,
        nextAt: null,
        error: "Delivery deadline or attempt budget exhausted.",
      },
    }
  return {
    target: "delivering",
    context: {
      ...context,
      attempts: context.attempts + 1,
      nextAt: event.now + LEASE_MS,
    },
  }
}
const retry = ({
  context,
  event,
}: {
  context: Context
  event: typeof Claim.Type
}) => {
  if (context.envelope.deadline <= event.now)
    throw failure("expired", "Expired messages cannot be retried.")
  return {
    target: "pending",
    context: {
      ...context,
      attemptLimit: context.attempts + MAX_ATTEMPTS,
      nextAt: event.now,
      error: null,
    },
  }
}

/** The existing outbox JSON is authoritative. These synchronous transitions run
 * in its transaction; transport work and durable wake delivery stay outside. */
export const outboxMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      CLAIM: Claim,
      ACK: Schema.Struct({ attempt: counter, receipt: Receipt }),
      FAILED: Failed,
      RETRY: Claim,
    },
  },
}).createMachine({
  id: "communication-outbox",
  version: "1",
  context: ({ input }) => input,
  initial: "pending",
  states: {
    pending: { on: { CLAIM: claim } },
    delivering: {
      on: {
        CLAIM: claim,
        ACK: ({ context, event }) => {
          if (context.attempts !== event.attempt) return
          if (
            event.receipt.id !== context.envelope.id ||
            event.receipt.taskId !== context.envelope.taskId
          )
            throw failure(
              "conflict",
              "Acknowledgment belongs to another message."
            )
          return {
            target: "accepted",
            context: {
              ...context,
              receipt: event.receipt,
              nextAt: null,
              error: null,
            },
          }
        },
        FAILED: ({ context, event }) => {
          if (context.attempts !== event.attempt) return
          const expired = context.envelope.deadline <= event.now
          const done =
            event.permanent || expired || event.attempt >= context.attemptLimit
          return {
            target: expired ? "expired" : done ? "failed" : "pending",
            context: {
              ...context,
              nextAt: done
                ? null
                : Math.min(context.envelope.deadline, event.now + event.delay),
              error: event.permanent
                ? "Delivery was rejected. Inspect this message before retrying."
                : "Delivery could not be confirmed; retries preserve its identity.",
            },
          }
        },
      },
    },
    accepted: {},
    failed: { on: { RETRY: retry } },
    expired: { on: { RETRY: retry } },
  },
})

export type DeliveryEvent = EventFromLogic<typeof outboxMachine>

function read(
  snapshot: ReturnType<typeof outboxMachine.resolveState>
): Delivery {
  return Schema.decodeUnknownSync(Delivery)({
    ...snapshot.context,
    status: Schema.decodeUnknownSync(Status)(snapshot.value),
  })
}

export function advanceDelivery(
  saved: unknown,
  event: DeliveryEvent
): Delivery | undefined {
  const { status, ...context } = Schema.decodeUnknownSync(Delivery)(saved)
  const snapshot = outboxMachine.resolveState({ value: status, context })
  const [next, effects] = transition(outboxMachine, snapshot, event)
  // No executable descriptors are permitted in the domain transaction. Invalid
  // events are dead letters from the integration validator and fail here too.
  if (effects.length) throw failure("invalid", "Invalid mailbox input.")
  return next.context === snapshot.context && next.value === snapshot.value
    ? undefined
    : read(next)
}

export function newDelivery(envelope: Envelope, now: number): Delivery {
  const [snapshot, effects] = initialTransition(outboxMachine, {
    schemaVersion: 1,
    workflowVersion: 1,
    envelope,
    attempts: 0,
    attemptLimit: MAX_ATTEMPTS,
    nextAt: now,
    error: null,
    receipt: null,
  })
  if (effects.length) throw failure("invalid", "Invalid mailbox input.")
  return read(snapshot)
}

export function claimDelivery(delivery: Delivery, now: number): Delivery {
  return advanceDelivery(delivery, { type: "CLAIM", now }) ?? delivery
}

export function acknowledge(
  delivery: Delivery,
  attempt: number,
  receipt: Receipt
): Delivery | undefined {
  return advanceDelivery(delivery, { type: "ACK", attempt, receipt })
}

export function deliveryFailed(
  delivery: Delivery,
  attempt: number,
  now: number,
  delay: number,
  permanent: boolean
): Delivery | undefined {
  return advanceDelivery(delivery, {
    type: "FAILED",
    attempt,
    now,
    delay,
    permanent,
  })
}

export function retryDelivery(
  delivery: Delivery,
  now: number
): Delivery | undefined {
  return advanceDelivery(delivery, { type: "RETRY", now })
}
