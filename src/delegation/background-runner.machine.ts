import { setupEffect } from "@xstate/effect"
import { Deferred, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const reply = Schema.declare((value): value is Deferred.Deferred<boolean> =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is Deferred.Deferred<void> =>
  Deferred.isDeferred(value)
)
const admission = Schema.Struct({ reply, allowed: Schema.Boolean })

/** Native Lifecycle and domain machines own dispatch/recovery. This actor owns
 * only local admission and close; it adds no callback ledger or retry budget. */
export const backgroundRunnerLifetime = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    events: {
      ADMIT: Schema.Struct({ reply }),
      CLOSE: Schema.Struct({ ack }),
    },
  },
  actions: {
    acknowledge: ({ params }: { params?: unknown }) =>
      Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
    respond: ({ params }: { params?: unknown }) => {
      const input = Schema.decodeUnknownSync(admission)(params)
      return Deferred.succeed(input.reply, input.allowed)
    },
  },
}).createMachine({
  id: "background-runner-lifetime",
  initial: "open",
  states: {
    open: {
      on: {
        ADMIT: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, allowed: true },
          })
        },
        CLOSE: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
          return { target: "closed" }
        },
      },
    },
    closed: {
      on: {
        ADMIT: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, allowed: false },
          })
        },
        CLOSE: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
        },
      },
    },
  },
})
