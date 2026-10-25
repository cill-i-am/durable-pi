import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { AppEvent } from "./contracts"

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Delivery = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  workflowVersion: Schema.Literal(1),
  state: Schema.Literals(["pending", "admitted", "cancelled", "exhausted"]),
  revision: nonnegative,
  attempts: nonnegative,
  nextAt: Schema.Number,
  deadline: Schema.Number,
  message: Schema.NullOr(Schema.String),
})
export const AppDeliveryRecord = Schema.Struct({
  ...AppEvent.fields,
  lifecycle: Delivery,
})
export type AppDeliveryRecord = typeof AppDeliveryRecord.Type
const { state: _, ...context } = Delivery.fields
const Context = Schema.Struct(context)
const fence = { revision: nonnegative }
export const appDeliveryMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    events: {
      ADMIT: Schema.Struct(fence),
      EXHAUST: Schema.Struct({ ...fence, message: Schema.String }),
      CANCEL: Schema.Struct({ ...fence, message: Schema.String }),
      DEFER: Schema.Struct({
        ...fence,
        now: Schema.Number,
        reason: Schema.Literals(["model", "capacity", "storage"]),
      }),
    },
  },
}).createMachine({
  id: "app-delivery",
  version: "1",
  context: () => ({
    schemaVersion: 1 as const,
    workflowVersion: 1 as const,
    revision: 0,
    attempts: 0,
    nextAt: 0,
    deadline: 0,
    message: null as string | null,
  }),
  initial: "pending",
  states: {
    pending: {
      on: {
        EXHAUST: ({ context, event }) =>
          context.revision === event.revision
            ? {
                target: "exhausted",
                context: {
                  ...context,
                  revision: context.revision + 1,
                  nextAt: 0,
                  message: event.message,
                },
              }
            : undefined,
        ADMIT: ({ context, event }) =>
          context.revision === event.revision
            ? {
                target: "admitted",
                context: {
                  ...context,
                  revision: context.revision + 1,
                  nextAt: 0,
                  message: null,
                },
              }
            : undefined,
        CANCEL: ({ context, event }) =>
          context.revision === event.revision
            ? {
                target: "cancelled",
                context: {
                  ...context,
                  revision: context.revision + 1,
                  nextAt: 0,
                  message: event.message,
                },
              }
            : undefined,
        DEFER: ({ context, event }) => {
          if (context.revision !== event.revision || event.now < context.nextAt)
            return
          const attempts = context.attempts + 1
          const exhausted = attempts >= 5
          return {
            target: exhausted ? "exhausted" : "pending",
            context: {
              ...context,
              revision: context.revision + 1,
              attempts,
              nextAt: exhausted
                ? 0
                : event.now +
                  Math.min(
                    300_000,
                    (event.reason === "model" ? 60_000 : 10_000) *
                      2 ** (attempts - 1)
                  ),
              message: exhausted
                ? "Delivery stopped after five attempts. The saved app state is retained. Reconnect the model or resolve the conversation failure, then send a new app interaction to notify the bot."
                : event.reason === "model"
                  ? "Connect this bot's model to deliver the saved app interaction."
                  : "The saved app interaction is waiting for conversation admission.",
            },
          }
        },
      },
    },
    admitted: {},
    cancelled: {},
    exhausted: {},
  },
})

/** Existing event identity, text, turn ID and state survive conversion. The SQL
 * queued column is only the pending index; the machine decides delivery. */
export function restoreAppDelivery(raw: unknown): AppDeliveryRecord {
  const event = Schema.decodeUnknownSync(AppEvent)(raw)
  const saved = raw as Record<string, unknown>
  const record = Schema.decodeUnknownSync(AppDeliveryRecord)(
    Object.hasOwn(saved, "lifecycle")
      ? saved
      : {
          ...event,
          lifecycle: {
            schemaVersion: 1,
            workflowVersion: 1,
            state: event.delivery === "queued" ? "admitted" : event.delivery,
            revision: 0,
            attempts: 0,
            nextAt: 0,
            deadline: Date.parse(event.createdAt) + 900_000,
            message: event.deliveryMessage ?? null,
          },
        }
  )
  const projection =
    record.lifecycle.state === "admitted" ? "queued" : record.lifecycle.state
  if (record.delivery !== projection || record.lifecycle.attempts > 5)
    throw new Error(
      "Incompatible app delivery record. Restore a compatible application version; preserve the event and interaction receipt."
    )
  return record
}
export function advanceAppDelivery(
  raw: unknown,
  event: EventFromLogic<typeof appDeliveryMachine>
): AppDeliveryRecord {
  const record = restoreAppDelivery(raw)
  const { state, ...context } = record.lifecycle
  const [next, effects] = transition(
    appDeliveryMachine,
    appDeliveryMachine.resolveState({ value: state, context }),
    event
  )
  if (effects.length)
    throw new Error("App delivery transactions cannot run effects")
  const lifecycle = Schema.decodeUnknownSync(Delivery)({
    ...next.context,
    state: next.value,
  })
  return {
    ...record,
    delivery: lifecycle.state === "admitted" ? "queued" : lifecycle.state,
    ...(lifecycle.message
      ? { deliveryMessage: lifecycle.message }
      : { deliveryMessage: undefined }),
    lifecycle,
  }
}
