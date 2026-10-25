import { setupEffect } from "@xstate/effect"
import { Deferred, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const facts = Schema.Struct({
  protected: Schema.Boolean,
  starting: Schema.Boolean,
})
const reply = Schema.declare((value): value is Deferred.Deferred<boolean> =>
  Deferred.isDeferred(value)
)
const answer = Schema.Struct({ reply, blocked: Schema.Boolean })
export const workspaceGuardMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: facts,
    context: Schema.Struct({
      started: Schema.Boolean,
      notice: Schema.Boolean,
      protected: Schema.Boolean,
    }),
    events: {
      OBSERVE: facts,
      CHECK: Schema.Struct({ protected: Schema.Boolean, reply }),
    },
  },
  actions: {
    answer: ({ params }: { params?: unknown }) => {
      const value = Schema.decodeUnknownSync(answer)(params)
      return Deferred.succeed(value.reply, value.blocked)
    },
  },
}).createMachine({
  id: "workspace-guard",
  initial: "restored",
  context: ({ input }) => ({
    started: !input.starting,
    notice: false,
    protected: input.protected,
  }),
  on: {
    OBSERVE: ({ context, event }) => ({
      target: event.protected ? ".blocked" : ".open",
      context: {
        protected: event.protected,
        started: context.started || !event.starting,
        notice: event.protected && context.notice,
      },
    }),
    CHECK: (args, enq) => {
      enq(args.actions.answer, {
        ...args,
        params: { reply: args.event.reply, blocked: args.event.protected },
      })
      return {
        target: args.event.protected ? ".blocked" : ".open",
        context: {
          ...args.context,
          protected: args.event.protected,
          notice: args.event.protected,
        },
      }
    },
  },
  states: {
    restored: {
      always: ({ context }) => ({
        target: context.protected ? "blocked" : "open",
      }),
    },
    blocked: {},
    open: {},
  },
})
