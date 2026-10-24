import { setupEffect } from "@xstate/effect"
import { Deferred, Schema } from "effect"
import { standardSchemaValidator } from "xstate/validation"

import { AppDiscovery } from "./discovery.machine"

export type AppRunnerPermission =
  | "start"
  | "stopped"
  | "new"
  | "reuse"
  | "spent"
  | "orphan"
  | "busy"
  | "rearm"
  | "reschedule"
  | "empty"
  | "pump"
  | "exhaust"
  | "defer"
  | "stale"
export type AppRunnerReply = Deferred.Deferred<AppRunnerPermission>
export type AppRunnerAck = Deferred.Deferred<void>
const reply = Schema.declare((value): value is AppRunnerReply =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is AppRunnerAck =>
  Deferred.isDeferred(value)
)
const job = Schema.declare(
  (value): value is object => typeof value === "object" && value !== null
)
const token = Schema.NonEmptyString
const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const entry = Schema.Struct({
  token,
  job,
  until: time,
  phase: Schema.Literals(["running", "failed", "exhausting"]),
})
const response = Schema.Struct({
  reply,
  permission: Schema.Literals([
    "start",
    "stopped",
    "new",
    "reuse",
    "spent",
    "orphan",
    "busy",
    "rearm",
    "reschedule",
    "empty",
    "pump",
    "exhaust",
    "defer",
    "stale",
  ]),
})

/** Local callback permission and scheduling ownership. The existing discovery
 * record remains durable lease authority; Lifecycle retains its retry budget. */
export const appRunnerMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Schema.Struct({
      entries: Schema.Array(entry),
      waiting: Schema.Array(reply),
    }),
    events: {
      SCHEDULE: Schema.Struct({ reply }),
      RELEASE: Schema.Struct({ ack }),
      ARM: Schema.Struct({
        lease: Schema.NullOr(AppDiscovery),
        now: time,
        reply,
      }),
      WAKE: Schema.Struct({ token: Schema.NullOr(token), reply }),
      ADMIT: Schema.Struct({
        token,
        job,
        until: time,
        current: Schema.Boolean,
        spent: Schema.Boolean,
        reply,
      }),
      ERROR: Schema.Struct({ token, job, current: Schema.Boolean, reply }),
      FINISHED: Schema.Struct({ token, job, ack }),
      FAILED: Schema.Struct({ token, job, ack }),
      SPENT: Schema.Struct({ token, job, ack }),
      CLOSE: Schema.Struct({ ack }),
    },
  },
  actions: {
    respond: ({ params }: { params?: unknown }) => {
      const value = Schema.decodeUnknownSync(response)(params)
      return Deferred.succeed(value.reply, value.permission)
    },
    acknowledge: ({ params }: { params?: unknown }) =>
      Deferred.succeed(Schema.decodeUnknownSync(ack)(params), undefined),
  },
}).createMachine({
  id: "app-runner",
  initial: "open",
  context: { entries: [], waiting: [] },
  on: {
    FINISHED: (args, enq) => {
      enq(args.actions.acknowledge, { ...args, params: args.event.ack })
      return {
        context: {
          ...args.context,
          entries: args.context.entries.filter(
            (entry) =>
              entry.token !== args.event.token || entry.job !== args.event.job
          ),
        },
      }
    },
    SPENT: (args, enq) => {
      enq(args.actions.acknowledge, { ...args, params: args.event.ack })
      return {
        context: {
          ...args.context,
          entries: args.context.entries.filter(
            (entry) =>
              entry.token !== args.event.token || entry.job !== args.event.job
          ),
        },
      }
    },
    FAILED: (args, enq) => {
      enq(args.actions.acknowledge, { ...args, params: args.event.ack })
      return {
        context: {
          ...args.context,
          entries: args.context.entries.map((entry) =>
            entry.token === args.event.token && entry.job === args.event.job
              ? { ...entry, phase: "failed" as const }
              : entry
          ),
        },
      }
    },
  },
  states: {
    open: {
      initial: "idle",
      on: {
        CLOSE: (args, enq) => {
          for (const reply of args.context.waiting)
            enq(args.actions.respond, {
              ...args,
              params: { reply, permission: "stopped" },
            })
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
          return { target: "closed", context: { ...args.context, waiting: [] } }
        },
        ARM: (args, enq) => {
          const { lease, now, reply } = args.event
          const active =
            lease &&
            args.context.entries.some((entry) => entry.token === lease.token)
          const permission =
            lease?.state === "exhausted"
              ? "spent"
              : active
                ? lease.armedUntil < now + 30_000
                  ? "busy"
                  : "reuse"
                : !lease &&
                    args.context.entries.some((entry) => entry.until > now)
                  ? "orphan"
                  : "new"
          enq(args.actions.respond, { ...args, params: { reply, permission } })
          return !lease && permission === "new"
            ? { context: { ...args.context, entries: [] } }
            : undefined
        },
        WAKE: (args, enq) => {
          const { token, reply } = args.event
          enq(args.actions.respond, {
            ...args,
            params: {
              reply,
              permission:
                token === null
                  ? "empty"
                  : args.context.entries.some((entry) => entry.token === token)
                    ? "rearm"
                    : "reschedule",
            },
          })
        },
        ADMIT: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: {
              reply: args.event.reply,
              permission: args.event.current ? "defer" : "stale",
            },
          })
        },
        ERROR: (args, enq) => {
          const owned = args.context.entries.find(
            (entry) => entry.token === args.event.token
          )
          const start =
            args.event.current &&
            owned?.job === args.event.job &&
            owned.phase === "failed"
          enq(args.actions.respond, {
            ...args,
            params: {
              reply: args.event.reply,
              permission: start ? "start" : "stale",
            },
          })
          return start
            ? {
                context: {
                  ...args.context,
                  entries: args.context.entries.map((entry) =>
                    entry === owned
                      ? { ...entry, phase: "exhausting" as const }
                      : entry
                  ),
                },
              }
            : undefined
        },
      },
      states: {
        idle: {
          on: {
            SCHEDULE: (args, enq) => {
              enq(args.actions.respond, {
                ...args,
                params: { reply: args.event.reply, permission: "start" },
              })
              return { target: "scheduling" }
            },
            ADMIT: (args, enq) => {
              const owned = args.context.entries.find(
                (entry) => entry.token === args.event.token
              )
              const permission = !args.event.current
                ? "stale"
                : args.event.spent
                  ? "exhaust"
                  : owned &&
                      (owned.job !== args.event.job || owned.phase !== "failed")
                    ? "defer"
                    : "pump"
              enq(args.actions.respond, {
                ...args,
                params: { reply: args.event.reply, permission },
              })
              return permission === "pump"
                ? {
                    context: {
                      ...args.context,
                      entries: [
                        ...args.context.entries.filter(
                          (entry) => entry.token !== args.event.token
                        ),
                        {
                          token: args.event.token,
                          job: args.event.job,
                          until: args.event.until,
                          phase: "running" as const,
                        },
                      ],
                    },
                  }
                : undefined
            },
          },
        },
        scheduling: {
          on: {
            SCHEDULE: ({ context, event }) => ({
              context: {
                ...context,
                waiting: [...context.waiting, event.reply],
              },
            }),
            RELEASE: (args, enq) => {
              enq(args.actions.acknowledge, { ...args, params: args.event.ack })
              const [next, ...waiting] = args.context.waiting
              if (next)
                enq(args.actions.respond, {
                  ...args,
                  params: { reply: next, permission: "start" },
                })
              return {
                target: next ? "scheduling" : "idle",
                context: { ...args.context, waiting },
              }
            },
          },
        },
      },
    },
    closed: {
      on: {
        SCHEDULE: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, permission: "stopped" },
          })
        },
        ARM: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, permission: "stopped" },
          })
        },
        WAKE: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, permission: "stopped" },
          })
        },
        ADMIT: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, permission: "stopped" },
          })
        },
        ERROR: (args, enq) => {
          enq(args.actions.respond, {
            ...args,
            params: { reply: args.event.reply, permission: "stopped" },
          })
        },
        RELEASE: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
        },
        CLOSE: (args, enq) => {
          enq(args.actions.acknowledge, { ...args, params: args.event.ack })
        },
      },
    },
  },
})
