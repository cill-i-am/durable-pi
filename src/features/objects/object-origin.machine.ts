import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { OriginConversation } from "@/objects/contracts"

export function objectOriginMachine(
  read: () => Effect.Effect<OriginConversation, unknown, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: Schema.String,
      context: Schema.Struct({
        identity: Schema.String,
        origin: Schema.NullOr(OriginConversation),
        failure: Schema.UndefinedOr(Schema.Unknown),
      }),
      events: { OPEN: Schema.Struct({}), CLOSE: Schema.Struct({}) },
    },
    actors: { read: createEffectLogic(() => Effect.exit(read())) },
  }).createMachine({
    id: "object-origin",
    initial: "closed",
    context: ({ input }) => ({
      identity: input,
      origin: null,
      failure: undefined,
    }),
    on: {
      OPEN: { target: ".loading", reenter: true },
      CLOSE: ({ context }) => ({
        target: ".closed",
        context: { ...context, origin: null, failure: undefined },
      }),
    },
    states: {
      closed: {},
      loading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            Exit.isFailure(event.output)
              ? {
                  target: "failed",
                  context: { ...context, failure: event.output.cause },
                }
              : {
                  target: "open",
                  context: {
                    ...context,
                    origin: event.output.value,
                    failure: undefined,
                  },
                },
        },
      },
      open: {},
      failed: {},
    },
  })
}
