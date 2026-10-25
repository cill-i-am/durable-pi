import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const view = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  shown: Schema.Boolean,
})
/** Preserve the agent component owning an outgoing settings stack until native
 * closure. The component's data stays in the host; this machine chooses its ID. */
export const settingsOwnerMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: view,
    context: Schema.Struct({ id: Schema.NullOr(Schema.String) }),
    events: { VIEW: view },
  },
}).createMachine({
  id: "settings-owner",
  context: ({ input }) => ({ id: input.id }),
  initial: "current",
  on: {
    VIEW: ({ context, event }) =>
      event.shown && context.id !== null && context.id !== event.id
        ? { target: ".retained" }
        : { target: ".current", context: { id: event.id } },
  },
  states: { current: {}, retained: {} },
})
