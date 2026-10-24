import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export type MaintenanceRestoreReply = Deferred.Deferred<void, unknown>
export type MaintenanceCloseAck = Deferred.Deferred<void>
const reply = Schema.declare((value): value is MaintenanceRestoreReply =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is MaintenanceCloseAck =>
  Deferred.isDeferred(value)
)
const result = Schema.Struct({
  replies: Schema.Array(reply),
  exit: Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  ),
})

/** Summary and Backup share only local activation/closed admission. Their
 * existing durable controller and dispatch machines retain all retry authority. */
export function maintenanceRunnerHostMachine<E>(
  restore: () => Effect.Effect<void, E, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        replies: Schema.Array(reply),
        generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        lastExit: Schema.NullOr(result.fields.exit),
      }),
      events: {
        RESTORE: Schema.Struct({
          reply,
          generation: Schema.Int.check(Schema.isGreaterThan(0)),
        }),
        CLOSE: Schema.Struct({ ack }),
      },
    },
    actions: {
      restored: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(result)(params)
        return Effect.forEach(
          value.replies,
          (reply) => Deferred.done(reply, value.exit),
          { discard: true }
        )
      },
      closed: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
    },
    actors: {
      restore: createEffectLogic(() => Effect.exit(restore())),
    },
  }).createMachine({
    id: "memory-runner-host",
    type: "parallel",
    context: { replies: [], generation: 0, lastExit: null },
    states: {
      admission: {
        initial: "open",
        on: {
          CLOSE: (args, enq) => {
            enq(args.actions.closed, { ...args, params: args.event.ack })
            return { target: ".closed" }
          },
        },
        states: { open: {}, closed: {} },
      },
      activation: {
        initial: "cold",
        states: {
          cold: {
            on: {
              RESTORE: (args, enq) => {
                if (
                  args.event.generation === args.context.generation &&
                  args.context.lastExit
                ) {
                  enq(args.actions.restored, {
                    ...args,
                    params: {
                      replies: [args.event.reply],
                      exit: args.context.lastExit,
                    },
                  })
                  return
                }
                if (
                  typeof args.value === "object" &&
                  args.value.admission === "open" &&
                  args.event.generation === args.context.generation + 1
                )
                  return {
                    target: "restoring",
                    context: {
                      ...args.context,
                      generation: args.event.generation,
                      replies: [args.event.reply],
                    },
                  }
                enq(args.actions.restored, {
                  ...args,
                  params: {
                    replies: [args.event.reply],
                    exit:
                      typeof args.value === "object" &&
                      args.value.admission === "closed"
                        ? Exit.void
                        : Exit.die(
                            new Error("Invalid Memory restoration generation")
                          ),
                  },
                })
              },
            },
          },
          restoring: {
            on: {
              RESTORE: (args, enq) => {
                if (args.event.generation === args.context.generation)
                  return {
                    context: {
                      ...args.context,
                      replies: [...args.context.replies, args.event.reply],
                    },
                  }
                enq(args.actions.restored, {
                  ...args,
                  params: {
                    replies: [args.event.reply],
                    exit:
                      args.event.generation === args.context.generation - 1 &&
                      args.context.lastExit
                        ? args.context.lastExit
                        : Exit.die(
                            new Error("Invalid Memory restoration generation")
                          ),
                  },
                })
              },
            },
            invoke: {
              src: "restore",
              onDone: (args, enq) => {
                enq(args.actions.restored, {
                  ...args,
                  params: {
                    replies: args.context.replies,
                    exit: args.event.output,
                  },
                })
                return {
                  target: Exit.isSuccess(args.event.output) ? "ready" : "cold",
                  context: {
                    ...args.context,
                    replies: [],
                    lastExit: args.event.output,
                  },
                }
              },
            },
          },
          ready: {
            on: {
              RESTORE: (args, enq) => {
                enq(args.actions.restored, {
                  ...args,
                  params: {
                    replies: [args.event.reply],
                    exit:
                      args.event.generation === args.context.generation
                        ? Exit.void
                        : Exit.die(
                            new Error("Invalid Memory restoration generation")
                          ),
                  },
                })
              },
            },
          },
        },
      },
    },
  })
}
