import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

/** Observation only; reconnect and visibility never submit retained mutations. */
export function objectPollMachine(
  refresh: () => Effect.Effect<void, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        active: Schema.Boolean,
        visible: Schema.Boolean,
      }),
      events: {
        OBSERVE: Schema.Struct({
          active: Schema.Boolean,
          visible: Schema.Boolean,
        }),
        REFRESH: Schema.Struct({}),
      },
    },
    actors: { refresh: createEffectLogic(() => Effect.exit(refresh())) },
  }).createMachine({
    id: "object-poll",
    initial: "paused",
    context: { active: false, visible: true },
    on: {
      OBSERVE: ({ context, event }) =>
        context.active === event.active && context.visible === event.visible
          ? undefined
          : {
              target: event.active && event.visible ? ".reading" : ".paused",
              context: { active: event.active, visible: event.visible },
            },
      REFRESH: ({ context }) =>
        context.active && context.visible
          ? { target: ".reading", reenter: true }
          : undefined,
    },
    states: {
      paused: {},
      reading: { invoke: { src: "refresh", onDone: { target: "waiting" } } },
      waiting: { after: { 4000: { target: "reading" } } },
    },
  })
}
