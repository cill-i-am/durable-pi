import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AgentStatuses } from "@/agents/contracts"

const observation = Schema.Struct({
  visible: Schema.Boolean,
  membership: Schema.String,
})
export function agentStatusesMachine(
  read: Effect.Effect<typeof AgentStatuses.Type, unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: observation,
      context: Schema.Struct({
        ...observation.fields,
        statuses: Schema.toType(AgentStatuses.fields.statuses),
        failure: Schema.Unknown,
        queued: Schema.Boolean,
      }),
      events: { OBSERVE: observation },
    },
    actors: {
      read: createEffectLogic(() => Effect.exit(read)),
      delay: createEffectLogic(() => Effect.sleep(30_000)),
    },
  }).createMachine({
    id: "agent-statuses",
    initial: "dormant",
    context: ({ input }) => ({
      ...input,
      statuses: [],
      failure: null,
      queued: false,
    }),
    on: {
      OBSERVE: ({ context, event }) => ({
        context: {
          ...context,
          visible: event.visible,
          membership: event.membership,
          queued: context.queued || event.membership !== context.membership,
        },
      }),
    },
    states: {
      dormant: {
        on: {
          OBSERVE: ({ context, event }) => ({
            target: !!event.membership && event.visible ? "reading" : "dormant",
            context: {
              ...context,
              visible: event.visible,
              membership: event.membership,
              queued: false,
            },
          }),
        },
      },
      reading: {
        invoke: {
          src: "read",
          onDone: ({ context, event }) =>
            context.queued && context.membership && context.visible
              ? {
                  target: "reading",
                  reenter: true,
                  context: { ...context, queued: false },
                }
              : {
                  target:
                    !!context.membership && context.visible
                      ? "waiting"
                      : "dormant",
                  context: {
                    ...context,
                    statuses: Exit.isSuccess(event.output)
                      ? event.output.value.statuses
                      : [],
                    queued: false,
                    failure: Exit.isFailure(event.output)
                      ? event.output.cause
                      : null,
                  },
                },
        },
      },
      waiting: {
        on: {
          OBSERVE: ({ context, event }) => ({
            target: !!event.membership && event.visible ? "reading" : "dormant",
            context: {
              ...context,
              visible: event.visible,
              membership: event.membership,
              queued: false,
            },
          }),
        },
        invoke: { src: "delay", onDone: { target: "reading" } },
      },
    },
  })
}
