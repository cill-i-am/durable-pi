import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const Receipt = Schema.Struct({
  rootId: Schema.String,
  owner: Schema.String,
  confirmed: Schema.Boolean,
  result: Schema.Struct({
    failed: Schema.Boolean,
    phase: Schema.Literals(["handoff", "observe", "stop"]),
    timedOut: Schema.Boolean,
    inspected: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
  }),
})
export type ControlReleaseReceipt = typeof Receipt.Type

/** Warm receipts are admitted only after joined native cleanup. Domain storage
 * remains the durable owner; this machine never authorizes another pump attempt. */
export const controlReleaseMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ receipts: Schema.Array(Receipt) }),
    events: {
      RETAIN: Schema.Struct({ receipt: Receipt }),
      RELEASED: Schema.Struct({ receipt: Receipt }),
    },
  },
}).createMachine({
  id: "conversation-joined-releases",
  initial: "clear",
  context: () => ({ receipts: [] }),
  on: {
    RETAIN: ({ context, event }) => {
      const prior = context.receipts.find(
        (value) => value.owner === event.receipt.owner
      )
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(event.receipt))
          throw new Error("Conversation release identity changed")
        return
      }
      return {
        target: ".pending",
        context: { receipts: [...context.receipts, event.receipt] },
      }
    },
    RELEASED: ({ context, event }) => {
      const receipts = context.receipts.filter(
        (value) =>
          value.owner !== event.receipt.owner ||
          JSON.stringify(value) !== JSON.stringify(event.receipt)
      )
      return {
        target: receipts.length ? ".pending" : ".clear",
        context: { receipts },
      }
    },
  },
  states: { clear: {}, pending: {} },
})
export const initialControlReleases = () =>
  initialTransition(controlReleaseMachine)[0]
export const advanceControlReleases = (
  state: ReturnType<typeof initialControlReleases>,
  event: EventFromLogic<typeof controlReleaseMachine>
) => transition(controlReleaseMachine, state, event)[0]
