import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { TaskRelease as Receipt } from "./contracts"

/** Warm receipts are admitted only after joined native cleanup. Domain storage
 * remains the durable owner; this machine never authorizes another pump attempt. */
export const taskReleaseMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ receipts: Schema.Array(Receipt) }),
    events: {
      RETAIN: Schema.Struct({ receipt: Receipt }),
      RELEASED: Schema.Struct({ receipt: Receipt }),
    },
  },
}).createMachine({
  id: "communication-joined-releases",
  initial: "clear",
  context: () => ({ receipts: [] }),
  on: {
    RETAIN: ({ context, event }) => {
      const prior = context.receipts.find(
        (value) => value.owner === event.receipt.owner
      )
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(event.receipt))
          throw new Error("Communication release identity changed")
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
export const initialTaskReleases = () =>
  initialTransition(taskReleaseMachine)[0]
export const advanceTaskReleases = (
  state: ReturnType<typeof initialTaskReleases>,
  event: EventFromLogic<typeof taskReleaseMachine>
) => transition(taskReleaseMachine, state, event)[0]
