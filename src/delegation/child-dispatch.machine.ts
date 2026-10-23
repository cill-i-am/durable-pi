import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { NativeId } from "./contracts"

export const ChildDispatch = Schema.Struct({
  request: Schema.String,
  childId: NativeId,
  text: Schema.String,
  steer: Schema.Boolean,
  state: Schema.Literals([
    "accepted",
    "dispatching",
    "confirmed",
    "unconfirmed",
    "rejected",
  ]),
  receipt: Schema.optional(NativeId),
})
export type ChildDispatch = typeof ChildDispatch.Type
const Context = Schema.Struct({ receipt: Schema.UndefinedOr(NativeId) })
const Events = {
  CLAIM: Schema.Struct({ authorized: Schema.Boolean }),
  ACCEPTED: Schema.Struct({ receipt: NativeId }),
  UNCERTAIN: Schema.Struct({}),
}
export const childDispatchMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: Events,
  },
}).createMachine({
  id: "local-child-dispatch",
  version: "1",
  initial: "accepted",
  context: ({ input }) => input,
  on: {
    ACCEPTED: ({ event }) => ({
      target: ".confirmed",
      context: { receipt: event.receipt },
    }),
  },
  states: {
    accepted: {
      on: {
        CLAIM: ({ event }) => ({
          target: event.authorized ? "dispatching" : "rejected",
        }),
      },
    },
    dispatching: {
      on: {
        CLAIM: ({ event }) => ({
          target: event.authorized ? "dispatching" : "unconfirmed",
        }),
        ACCEPTED: ({ event }) => ({
          target: "confirmed",
          context: { receipt: event.receipt },
        }),
        UNCERTAIN: { target: "unconfirmed" },
      },
    },
    unconfirmed: {
      on: {
        CLAIM: ({ event }) =>
          event.authorized ? { target: "dispatching" } : undefined,
        ACCEPTED: ({ event }) => ({
          target: "confirmed",
          context: { receipt: event.receipt },
        }),
      },
    },
    confirmed: {},
    rejected: {},
  },
})
export function advanceChildDispatch(
  saved: ChildDispatch,
  event: EventFromLogic<typeof childDispatchMachine>
): ChildDispatch {
  if (!event || !Object.hasOwn(Events, event.type))
    throw new Error("Invalid child dispatch event")
  Schema.decodeUnknownSync(
    Schema.Struct({
      type: Schema.Literal(event.type),
      ...Events[event.type].fields,
    }),
    { onExcessProperty: "error" }
  )(event)
  const record = Schema.decodeUnknownSync(ChildDispatch)(saved)
  const [next, effects] = transition(
    childDispatchMachine,
    childDispatchMachine.resolveState({
      value: record.state,
      context: { receipt: record.receipt },
    }),
    event
  )
  if (effects.length) throw new Error("Unexpected child dispatch effect")
  return Schema.decodeUnknownSync(ChildDispatch)({
    ...record,
    state: next.value,
    ...(next.context.receipt === undefined
      ? {}
      : { receipt: next.context.receipt }),
  })
}
