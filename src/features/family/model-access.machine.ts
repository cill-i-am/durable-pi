import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export function modelAccessMachine(refresh: Effect.Effect<void>) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ saved: Schema.Boolean, queued: Schema.Boolean }),
      events: { REFRESH: Schema.Struct({}), CONNECTED: Schema.Struct({}) },
    },
    actors: { refresh: createEffectLogic(() => refresh) },
  }).createMachine({
    id: "model-access",
    initial: "idle",
    context: { saved: false, queued: false },
    states: {
      idle: {
        on: {
          REFRESH: { target: "checking" },
          CONNECTED: ({ context }) => ({
            target: "checking",
            context: { ...context, saved: true },
          }),
        },
      },
      checking: {
        on: {
          CONNECTED: ({ context }) => ({
            context: { ...context, saved: true, queued: true },
          }),
        },
        invoke: {
          src: "refresh",
          onDone: ({ context }) =>
            context.queued
              ? {
                  target: "checking",
                  reenter: true,
                  context: { ...context, queued: false },
                }
              : { target: "idle" },
        },
      },
    },
  })
}
