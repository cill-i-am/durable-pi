import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Context, Effect, Schema, Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** Conformance reference for a local attachment preparation lifetime. */
export class Preparation extends Context.Service<
  Preparation,
  { readonly prepare: Effect.Effect<string, string, Scope.Scope> }
>()("test/Preparation") {}

export const preparationMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { events: { START: Schema.Struct({}), CANCEL: Schema.Struct({}) } },
  actors: {
    prepare: createEffectLogic(Preparation.use((service) => service.prepare)),
  },
}).createMachine({
  initial: "idle",
  states: {
    idle: { on: { START: { target: "preparing" } } },
    preparing: {
      invoke: {
        src: "prepare",
        onDone: { target: "ready" },
        onError: { target: "failed" },
      },
      after: { 1000: { target: "expired" } },
      on: { CANCEL: { target: "cancelled" } },
    },
    ready: { type: "final" },
    failed: { type: "final" },
    expired: { type: "final" },
    cancelled: { type: "final" },
  },
})
