import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Clock, Effect, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

const deadline = Schema.Struct({
  deadline: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})

/** One command-owned timer. SET can extend startup for an interactive session
 * or shorten it for Save, but cannot revive a command whose deadline elapsed. */
export function terminalDeadlineMachine(work: {
  now: () => number
  expire: Effect.Effect<void>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      input: deadline,
      context: deadline,
      events: { SET: deadline, CANCEL: Schema.Struct({}) },
    },
    actors: {
      wait: createEffectLogic(({ input }: { input: number }) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Effect.sleep(Math.max(0, input - now)))
        )
      ),
    },
    actions: {
      expire: (_args: unknown) => work.expire,
    },
  }).createMachine({
    id: "terminal-deadline",
    context: ({ input }) => input,
    initial: "waiting",
    states: {
      waiting: {
        invoke: {
          src: "wait",
          input: ({ context }) => context.deadline,
          onDone: { target: "expired" },
        },
        on: {
          SET: ({ context, event }) => ({
            target:
              work.now() >= context.deadline || work.now() >= event.deadline
                ? "expired"
                : "waiting",
            reenter: true,
            context: { deadline: event.deadline },
          }),
          CANCEL: { target: "cancelled" },
        },
      },
      expired: {
        type: "final",
        entry: (args, enq) => {
          enq(args.actions.expire, args)
        },
      },
      cancelled: { type: "final" },
    },
  })
}
