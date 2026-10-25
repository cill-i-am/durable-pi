import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema, type Scope } from "effect"
import type { StateValue } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

export type RunnerPermission =
  | "start"
  | "defer"
  | "stale"
  | "schedule"
  | "rearm"
  | "stopped"
export type RunnerReply = Deferred.Deferred<RunnerPermission>
export type RunnerAck = Deferred.Deferred<void>
export type RestoreReply = Deferred.Deferred<void, unknown>
const reply = Schema.declare((value): value is RunnerReply =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is RunnerAck =>
  Deferred.isDeferred(value)
)
const restoreReply = Schema.declare((value): value is RestoreReply =>
  Deferred.isDeferred(value)
)
const job = Schema.declare(
  (value): value is object => typeof value === "object" && value !== null
)
const response = Schema.Struct({
  reply,
  permission: Schema.Literals([
    "start",
    "defer",
    "stale",
    "schedule",
    "rearm",
    "stopped",
  ]),
})
const restored = Schema.Struct({
  replies: Schema.Array(restoreReply),
  exit: Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  ),
})
function inRegion(value: StateValue, region: string, phase: string) {
  return typeof value === "object" && value[region] === phase
}

/** Local activation/callback ownership only. Jobs, retries and durable wakes
 * remain Lifecycle's; the owning capability joins native handles at disposal. */
export function coordinationRunnerMachine(work: {
  restore: () => Effect.Effect<void, unknown, Scope.Scope>
}) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        owner: Schema.NullOr(job),
        wakeRequested: Schema.Boolean,
        restores: Schema.Array(restoreReply),
      }),
      events: {
        RESTORE: Schema.Struct({ reply: restoreReply }),
        ADMIT: Schema.Struct({ job, current: Schema.Boolean, reply }),
        EXHAUST: Schema.Struct({ job, reply }),
        STEP_FINISHED: Schema.Struct({ job, reply }),
        STEP_FAILED: Schema.Struct({ job, ack }),
        EXHAUSTED: Schema.Struct({ job, ack }),
        WAKE: Schema.Struct({ reply }),
        ARM: Schema.Struct({ reply }),
        CLOSE: Schema.Struct({ ack }),
      },
    },
    actions: {
      respond: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(response)(params)
        return Deferred.succeed(input.reply, input.permission)
      },
      acknowledge: ({ params }: { params?: unknown }) =>
        Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
      restored: ({ params }: { params?: unknown }) => {
        const input = Schema.decodeUnknownSync(restored)(params)
        return Effect.forEach(
          input.replies,
          (reply) => Deferred.done(reply, input.exit),
          { discard: true }
        )
      },
    },
    actors: { restore: createEffectLogic(() => Effect.exit(work.restore())) },
  }).createMachine({
    id: "coordination-runner",
    type: "parallel",
    context: { owner: null, wakeRequested: false, restores: [] },
    on: {
      ARM: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission: inRegion(args.value, "admission", "open")
              ? "schedule"
              : "stopped",
          },
        })
      },
      ADMIT: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission: !inRegion(args.value, "admission", "open")
              ? "stopped"
              : args.event.current
                ? "defer"
                : "stale",
          },
        })
      },
      EXHAUST: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission: inRegion(args.value, "admission", "open")
              ? "defer"
              : "stopped",
          },
        })
      },
      STEP_FINISHED: (args, enq) => {
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, permission: "schedule" },
        })
      },
      STEP_FAILED: (args, enq) => {
        enq(args.actions.acknowledge, { ...args, params: args.event.ack })
      },
      EXHAUSTED: (args, enq) => {
        enq(args.actions.acknowledge, { ...args, params: args.event.ack })
      },
      WAKE: (args, enq) => {
        const open = inRegion(args.value, "admission", "open")
        const coalesce =
          inRegion(args.value, "dispatch", "running") ||
          inRegion(args.value, "dispatch", "failed")
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission: !open ? "stopped" : coalesce ? "rearm" : "schedule",
          },
        })
        return open && coalesce
          ? { context: { ...args.context, wakeRequested: true } }
          : undefined
      },
    },
    states: {
      admission: {
        initial: "open",
        on: {
          CLOSE: (args, enq) => {
            enq(args.actions.acknowledge, { ...args, params: args.event.ack })
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
                if (inRegion(args.value, "admission", "open"))
                  return {
                    target: "restoring",
                    context: { ...args.context, restores: [args.event.reply] },
                  }
                enq(args.actions.restored, {
                  ...args,
                  params: { replies: [args.event.reply], exit: Exit.void },
                })
              },
            },
          },
          restoring: {
            on: {
              RESTORE: ({ context, event }) => ({
                context: {
                  ...context,
                  restores: [...context.restores, event.reply],
                },
              }),
            },
            invoke: {
              src: "restore",
              onDone: (args, enq) => {
                enq(args.actions.restored, {
                  ...args,
                  params: {
                    replies: args.context.restores,
                    exit: args.event.output,
                  },
                })
                return {
                  target: Exit.isSuccess(args.event.output) ? "ready" : "cold",
                  context: { ...args.context, restores: [] },
                }
              },
            },
          },
          ready: {
            on: {
              RESTORE: (args, enq) => {
                enq(args.actions.restored, {
                  ...args,
                  params: { replies: [args.event.reply], exit: Exit.void },
                })
              },
            },
          },
        },
      },
      dispatch: {
        initial: "idle",
        states: {
          idle: {
            on: {
              ADMIT: (args, enq) => {
                if (
                  !inRegion(args.value, "admission", "open") ||
                  !inRegion(args.value, "activation", "ready") ||
                  !args.event.current
                )
                  return
                enq(args.actions.respond, {
                  ...args,
                  params: { reply: args.event.reply, permission: "start" },
                })
                return {
                  target: "running",
                  context: {
                    ...args.context,
                    owner: args.event.job,
                    wakeRequested: false,
                  },
                }
              },
              EXHAUST: (args, enq) => {
                if (!inRegion(args.value, "admission", "open")) return
                enq(args.actions.respond, {
                  ...args,
                  params: { reply: args.event.reply, permission: "start" },
                })
                return {
                  target: "exhausting",
                  context: {
                    ...args.context,
                    owner: args.event.job,
                    wakeRequested: false,
                  },
                }
              },
            },
          },
          running: {
            on: {
              STEP_FINISHED: (args, enq) => {
                enq(args.actions.respond, {
                  ...args,
                  params: {
                    reply: args.event.reply,
                    permission:
                      args.context.owner === args.event.job &&
                      args.context.wakeRequested
                        ? "rearm"
                        : "schedule",
                  },
                })
                return args.context.owner === args.event.job
                  ? {
                      target: "idle",
                      context: {
                        ...args.context,
                        owner: null,
                        wakeRequested: false,
                      },
                    }
                  : undefined
              },
              STEP_FAILED: (args, enq) => {
                enq(args.actions.acknowledge, {
                  ...args,
                  params: args.event.ack,
                })
                return args.context.owner === args.event.job
                  ? { target: "failed" }
                  : undefined
              },
            },
          },
          failed: {
            on: {
              ADMIT: (args, enq) => {
                if (
                  !inRegion(args.value, "admission", "open") ||
                  !args.event.current ||
                  args.context.owner !== args.event.job
                )
                  return
                enq(args.actions.respond, {
                  ...args,
                  params: { reply: args.event.reply, permission: "start" },
                })
                return { target: "running" }
              },
              EXHAUST: (args, enq) => {
                if (
                  !inRegion(args.value, "admission", "open") ||
                  args.context.owner !== args.event.job
                )
                  return
                enq(args.actions.respond, {
                  ...args,
                  params: { reply: args.event.reply, permission: "start" },
                })
                return { target: "exhausting" }
              },
            },
          },
          exhausting: {
            on: {
              EXHAUSTED: (args, enq) => {
                enq(args.actions.acknowledge, {
                  ...args,
                  params: args.event.ack,
                })
                return args.context.owner === args.event.job
                  ? {
                      target: "idle",
                      context: {
                        ...args.context,
                        owner: null,
                        wakeRequested: false,
                      },
                    }
                  : undefined
              },
            },
          },
        },
      },
    },
  })
}
