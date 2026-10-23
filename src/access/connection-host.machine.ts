import { setupEffect } from "@xstate/effect"
import { Cause, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const failure = Schema.declare((value): value is Cause.Cause<unknown> =>
  Cause.isCause(value)
)
export const connectionHostMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      active: Schema.Array(Schema.String),
      failure: Schema.NullOr(failure),
    }),
    events: {
      ADMIT: Schema.Struct({ id: Schema.String }),
      RELEASE: Schema.Struct({
        id: Schema.String,
        failure: Schema.NullOr(failure),
      }),
      CLOSE: Schema.Struct({}),
      SETTLED: Schema.Struct({}),
    },
  },
}).createMachine({
  id: "mcp-connection-host",
  initial: "open",
  context: () => ({
    active: [] as string[],
    failure: null as Cause.Cause<unknown> | null,
  }),
  states: {
    open: {
      on: {
        ADMIT: ({ context, event }) => ({
          context: { ...context, active: [...context.active, event.id] },
        }),
        RELEASE: ({ context, event }) => ({
          context: {
            ...context,
            active: context.active.filter((id) => id !== event.id),
          },
        }),
        CLOSE: { target: "draining" },
      },
    },
    draining: {
      always: ({ context }) =>
        context.active.length === 0 ? { target: "settling" } : {},
      on: {
        RELEASE: ({ context, event }) => ({
          context: {
            active: context.active.filter((id) => id !== event.id),
            failure:
              event.failure && Cause.hasDies(event.failure)
                ? Cause.fromReasons([
                    ...(context.failure?.reasons ?? []),
                    ...event.failure.reasons,
                  ])
                : context.failure,
          },
        }),
      },
    },
    settling: { on: { SETTLED: { target: "closed" } } },
    closed: { type: "final" },
  },
})
