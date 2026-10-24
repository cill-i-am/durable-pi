import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export function interactiveHostMachine(
  work: Effect.Effect<never, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({ failure: Schema.Unknown }),
      events: { READY: Schema.Struct({}) },
    },
    actors: { host: createEffectLogic(Effect.exit(work)) },
  }).createMachine({
    id: "interactive-terminal-host",
    initial: "owned",
    context: () => ({ failure: undefined }),
    states: {
      owned: {
        initial: "loading",
        invoke: {
          src: "host",
          onDone: ({ event }) => ({
            target: "failed",
            context: {
              failure: Exit.isFailure(event.output)
                ? event.output.cause
                : undefined,
            },
          }),
        },
        states: { loading: { on: { READY: { target: "ready" } } }, ready: {} },
      },
      failed: {},
    },
  })
}
