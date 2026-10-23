import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { reject } from "./contracts"

const Context = Schema.Struct({
  authorized: Schema.Boolean,
  previous: Schema.UndefinedOr(
    Schema.Struct({ hash: Schema.String, run_id: Schema.String })
  ),
  payloadHash: Schema.String,
  active: Schema.Boolean,
  occupied: Schema.Boolean,
  count: Schema.Int,
})

/** One synchronous transaction reconstructs these facts and admits the machine's
 * decision together with the immutable event receipt and the routine run. */
export const webhookAdmissionMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: { ACCEPT: Schema.Struct({}) },
  },
}).createMachine({
  id: "webhook-admission",
  initial: "received",
  context: ({ input }) => input,
  states: {
    received: {
      on: {
        ACCEPT: ({ context }) => {
          if (!context.authorized)
            return reject("unauthorized", "Invalid webhook authorization.")
          if (context.previous) {
            if (context.previous.hash !== context.payloadHash)
              return reject(
                "conflict",
                "This event ID already belongs to different data."
              )
            return { target: "duplicate" }
          }
          if (!context.active)
            return reject("conflict", "This routine is paused or unavailable.")
          if (context.occupied)
            return reject(
              "busy",
              "This bot already has a routine waiting or running. Retry this event later."
            )
          if (context.count >= 2000)
            return reject(
              "conflict",
              "This bot reached its webhook event limit."
            )
          return { target: "accepted" }
        },
      },
    },
    accepted: { type: "final" },
    duplicate: { type: "final" },
  },
})
export function acceptWebhookEvent(input: typeof Context.Type) {
  const [initial, initialEffects] = initialTransition(
    webhookAdmissionMachine,
    input
  )
  const [next, effects] = transition(webhookAdmissionMachine, initial, {
    type: "ACCEPT",
  })
  if (
    [...initialEffects, ...effects].some(
      (effect) => effect.type !== "@xstate.terminate"
    )
  )
    throw new Error("Unsupported webhook admission effect")
  return next.value === "duplicate" ? input.previous! : undefined
}
