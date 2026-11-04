import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

/** Native SDK setters and storage guards must decide synchronously. The SDK
 * keeps its credential work; this machine owns immutable identity admission. */
export const oauthBindingMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      id: Schema.NullOr(Schema.String),
      revision: Schema.UndefinedOr(Schema.Number),
    }),
    events: {
      BIND: Schema.Struct({ id: Schema.String }),
      RESOLVED: Schema.Struct({ revision: Schema.UndefinedOr(Schema.Number) }),
      FAILED: Schema.Struct({}),
      USE: Schema.Struct({
        active: Schema.Boolean,
        revision: Schema.UndefinedOr(Schema.Number),
      }),
    },
  },
}).createMachine({
  id: "oauth-provider-binding",
  initial: "unbound",
  context: () => ({ id: null, revision: undefined }),
  on: {
    BIND: ({ context, event }) => {
      if (context.id === event.id) return
      if (context.id !== null)
        throw new Error("An OAuth provider cannot change connection identity")
      return {
        target: ".resolving",
        context: { id: event.id, revision: undefined },
      }
    },
  },
  states: {
    unbound: {},
    resolving: {
      on: {
        RESOLVED: ({ context, event }) => ({
          target: event.revision === undefined ? "unavailable" : "bound",
          context: { ...context, revision: event.revision },
        }),
        FAILED: { target: "unavailable" },
      },
    },
    bound: {
      on: {
        USE: ({ context, event }) =>
          event.active && event.revision === context.revision ? {} : undefined,
      },
    },
    unavailable: {},
  },
})
export const initialOAuthBinding = () =>
  initialTransition(oauthBindingMachine)[0]
export const advanceOAuthBinding = (
  state: ReturnType<typeof initialOAuthBinding>,
  event: EventFromLogic<typeof oauthBindingMachine>
) => transition(oauthBindingMachine, state, event)[0]
