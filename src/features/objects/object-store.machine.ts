import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

/** Synchronous host admission surrounds the scoped edit/read/poll actors.
 * Closing revokes admission before native actor acquisition and cleanup join. */
export const objectStoreMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({ error: Schema.String }),
    events: {
      CONNECT: Schema.Struct({}),
      LOADED: Schema.Struct({}),
      FAILED: Schema.Struct({ error: Schema.String }),
      EDIT: Schema.Struct({}),
      CLOSE: Schema.Struct({}),
      JOINED: Schema.Struct({}),
    },
  },
}).createMachine({
  id: "object-store-host",
  initial: "open",
  context: { error: "" },
  states: {
    open: {
      initial: "unconnected",
      on: {
        EDIT: ({ context }) => (context.error ? undefined : {}),
        CLOSE: { target: "closing" },
      },
      states: {
        unconnected: { on: { CONNECT: { target: "loading" } } },
        loading: {
          on: {
            LOADED: { target: "ready" },
            FAILED: ({ event }) => ({
              target: "blocked",
              context: { error: event.error },
            }),
          },
        },
        ready: {},
        blocked: {},
      },
    },
    closing: { on: { JOINED: { target: "closed" } } },
    closed: {},
  },
})
export const initialObjectStore = () => initialTransition(objectStoreMachine)[0]
export const advanceObjectStore = (
  state: ReturnType<typeof initialObjectStore>,
  event: EventFromLogic<typeof objectStoreMachine>
) => transition(objectStoreMachine, state, event)[0]
