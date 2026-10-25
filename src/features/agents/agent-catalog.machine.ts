import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AgentProfile } from "@/agents/contracts"

const reply = Schema.declare(
  (value): value is Deferred.Deferred<void, unknown> =>
    Deferred.isDeferred(value)
)
const answer = Schema.Struct({
  replies: Schema.Array(reply),
  result: Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  ),
})
export function agentCatalogMachine(
  read: Effect.Effect<readonly AgentProfile[], unknown>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        agents: Schema.Array(Schema.toType(AgentProfile)),
        loading: Schema.Boolean,
        error: Schema.String,
        failure: Schema.Unknown,
        queued: Schema.Boolean,
        replies: Schema.Array(reply),
      }),
      events: { REFRESH: Schema.Struct({ reply }) },
    },
    actors: { read: createEffectLogic(() => Effect.exit(read)) },
    actions: {
      answer: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(answer)(params)
        return Effect.forEach(
          value.replies,
          (reply) => Deferred.done(reply, value.result),
          { discard: true }
        )
      },
    },
  }).createMachine({
    id: "agent-catalog",
    initial: "loading",
    context: {
      agents: [],
      loading: true,
      error: "",
      failure: null,
      queued: false,
      replies: [],
    },
    states: {
      loading: {
        on: {
          REFRESH: ({ context, event }) => ({
            context: {
              ...context,
              queued: true,
              replies: [...context.replies, event.reply],
            },
          }),
        },
        invoke: {
          src: "read",
          onDone: (args, enq) => {
            const { context, event } = args
            if (context.queued)
              return {
                target: "loading",
                reenter: true,
                context: { ...context, queued: false },
              }
            enq(args.actions.answer, {
              ...args,
              params: {
                replies: context.replies,
                result: Exit.isSuccess(event.output) ? Exit.void : event.output,
              },
            })
            return {
              target: "ready",
              context: {
                ...context,
                loading: false,
                replies: [],
                agents: Exit.isSuccess(event.output)
                  ? event.output.value
                  : context.agents,
                error: Exit.isFailure(event.output)
                  ? "Could not load your bots. Try again."
                  : "",
                failure: Exit.isFailure(event.output)
                  ? event.output.cause
                  : null,
              },
            }
          },
        },
      },
      ready: {
        on: {
          REFRESH: ({ context, event }) => ({
            target: "loading",
            context: { ...context, replies: [event.reply] },
          }),
        },
      },
    },
  })
}
