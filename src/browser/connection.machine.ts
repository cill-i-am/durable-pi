import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** The native connection deadline revokes transport access, never session ownership. */
export function browserConnectionMachine(disconnect: Effect.Effect<void>) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: { context: Schema.Struct({}) },
    actors: { disconnect: createEffectLogic(Effect.exit(disconnect)) },
  }).createMachine({
    id: "browser-connection",
    context: () => ({}),
    initial: "connected",
    states: {
      connected: { after: { 30000: { target: "disconnecting" } } },
      disconnecting: {
        invoke: { src: "disconnect", onDone: { target: "closed" } },
      },
      closed: { type: "final" },
    },
  })
}
