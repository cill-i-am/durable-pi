import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export type WorkspaceRestoreReply = Deferred.Deferred<void, unknown>
export type WorkspaceRunnerAck = Deferred.Deferred<void>
const reply = Schema.declare((value): value is WorkspaceRestoreReply =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is WorkspaceRunnerAck =>
  Deferred.isDeferred(value)
)
const result = Schema.Struct({
  replies: Schema.Array(reply),
  exit: Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  ),
})

import {
  WorkspacePump,
  WorkspacePreparationClaim,
  decideWorkspacePump,
} from "./discovery.machine"

const permission = Schema.Literals([
  "start",
  "stopped",
  "defer",
  "stale",
  "rearm",
  "schedule",
  "empty",
])
const decision = Schema.Struct({
  permission,
  pump: Schema.NullOr(WorkspacePump),
  at: Schema.Number,
})
export type WorkspaceRunnerDecision = typeof decision.Type
export type WorkspaceRunnerReply = Deferred.Deferred<WorkspaceRunnerDecision>
const decisionReply = Schema.declare((value): value is WorkspaceRunnerReply =>
  Deferred.isDeferred(value)
)
const response = Schema.Struct({ reply: decisionReply, ...decision.fields })
const job = Schema.declare(
  (value): value is object => typeof value === "object" && value !== null
)
const entry = Schema.Struct({
  token: Schema.NonEmptyString,
  job,
  phase: Schema.Literals(["running", "failed", "exhausting", "retained"]),
  pump: Schema.NullOr(WorkspacePump),
  wakeRequested: Schema.Boolean,
})
function open(value: import("xstate").StateValue) {
  return typeof value === "object" && value.admission === "open"
}

/** Local callback and activation authority. Domain receipts, SQL revisions and
 * Lifecycle remain the durable owners; this machine never grants a new retry. */
export function workspaceRunnerMachine<E>(
  restore: () => Effect.Effect<void, E, Scope.Scope>
) {
  return setupEffect({
    validator: standardSchemaValidator(),
    schemas: {
      context: Schema.Struct({
        replies: Schema.Array(reply),
        entries: Schema.Array(entry),
        waiting: Schema.Array(decisionReply),
        generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        lastExit: Schema.NullOr(result.fields.exit),
      }),
      events: {
        RESTORE: Schema.Struct({
          reply,
          generation: Schema.Int.check(Schema.isGreaterThan(0)),
        }),
        CLOSE: Schema.Struct({ ack }),
        SCHEDULE: Schema.Struct({ reply: decisionReply }),
        RELEASE: Schema.Struct({ ack }),
        ADMIT: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          current: Schema.Boolean,
          pump: Schema.NullOr(WorkspacePump),
          now: Schema.Number,
          reply: decisionReply,
        }),
        ERROR: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          current: Schema.Boolean,
          pump: Schema.NullOr(WorkspacePump),
          now: Schema.Number,
          reply: decisionReply,
        }),
        WAKE: Schema.Struct({
          token: Schema.NullOr(Schema.NonEmptyString),
          cleanup: Schema.Boolean,
          reply: decisionReply,
        }),
        CLAIMED: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          claim: WorkspacePreparationClaim,
          ack,
        }),
        DEFER_CLEANUP: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          at: Schema.Number,
          reply: decisionReply,
        }),
        FINISHED: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          retain: Schema.Boolean,
          reply: decisionReply,
        }),
        FAILED: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          now: Schema.Number,
          ack,
        }),
      },
    },
    actions: {
      respond: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(response)(params)
        return Deferred.succeed(value.reply, {
          permission: value.permission,
          pump: value.pump,
          at: value.at,
        })
      },
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
    id: "workspace-runner",
    type: "parallel",
    context: {
      replies: [],
      generation: 0,
      lastExit: null,
      entries: [],
      waiting: [],
    },
    on: {
      ADMIT: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) => entry.token === args.event.token
        )
        const live = args.context.entries.find(
          (entry) =>
            (args.event.pump
              ? !!entry.pump
              : entry.token === args.event.token) &&
            entry.phase !== "retained" &&
            (entry.job !== args.event.job || entry.phase !== "failed")
        )
        const permission = !open(args.value)
          ? "stopped"
          : !args.event.current
            ? "stale"
            : live ||
                (typeof args.value === "object" &&
                  args.value.scheduling === "held")
              ? "defer"
              : "start"
        const orphan =
          !owned && args.event.pump
            ? args.context.entries.find(
                (entry) =>
                  entry.phase === "retained" && entry.pump?.phase === "cleanup"
              )
            : undefined
        const pump =
          owned?.pump ??
          (orphan?.pump
            ? decideWorkspacePump(orphan.pump, {
                type: "TRANSFER",
                token: args.event.token,
              })
            : args.event.pump)
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission,
            pump,
            at: Math.max(args.event.now + 1000, live?.pump?.cleanupAt ?? 0),
          },
        })
        if (permission === "start")
          return {
            context: {
              ...args.context,
              entries: [
                ...args.context.entries.filter(
                  (entry) => entry !== owned && entry !== orphan
                ),
                {
                  token: args.event.token,
                  job: args.event.job,
                  phase: "running" as const,
                  pump,
                  wakeRequested: owned?.wakeRequested ?? false,
                },
              ],
            },
          }
      },
      ERROR: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) => entry.token === args.event.token
        )
        const live = args.context.entries.find(
          (entry) =>
            (args.event.pump
              ? !!entry.pump
              : entry.token === args.event.token) &&
            entry.phase !== "retained" &&
            (entry.job !== args.event.job || entry.phase !== "failed")
        )
        const permission = !open(args.value)
          ? "stopped"
          : !args.event.current
            ? "stale"
            : live ||
                (typeof args.value === "object" &&
                  args.value.scheduling === "held")
              ? "defer"
              : "start"
        const current = owned?.pump ?? args.event.pump
        const pump =
          permission === "start" && current
            ? decideWorkspacePump(
                decideWorkspacePump(current, {
                  type: "FAILED",
                  now: args.event.now,
                }),
                { type: "EXHAUSTED" }
              )
            : current
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission,
            pump,
            at: Math.max(args.event.now + 1000, live?.pump?.cleanupAt ?? 0),
          },
        })
        if (permission === "start")
          return {
            context: {
              ...args.context,
              entries: [
                ...args.context.entries.filter((entry) => entry !== owned),
                {
                  token: args.event.token,
                  job: args.event.job,
                  phase: "exhausting" as const,
                  pump,
                  wakeRequested: owned?.wakeRequested ?? false,
                },
              ],
            },
          }
        if (
          permission === "stale" &&
          owned?.job === args.event.job &&
          owned.phase === "failed"
        )
          return {
            context: {
              ...args.context,
              entries: args.context.entries.map((entry) =>
                entry === owned
                  ? { ...entry, phase: "retained" as const }
                  : entry
              ),
            },
          }
      },
      WAKE: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) => entry.token === args.event.token
        )
        const permission = !open(args.value)
          ? "stopped"
          : args.event.token === null
            ? "empty"
            : owned || args.event.cleanup
              ? "rearm"
              : "schedule"
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, permission, pump: null, at: 0 },
        })
        if (permission === "rearm")
          return {
            context: {
              ...args.context,
              entries: args.context.entries.map((entry) =>
                entry === owned ? { ...entry, wakeRequested: true } : entry
              ),
            },
          }
      },
      CLAIMED: (args, enq) => {
        enq(args.actions.closed, { ...args, params: args.event.ack })
        return {
          context: {
            ...args.context,
            entries: args.context.entries.map((entry) =>
              entry.token === args.event.token &&
              entry.job === args.event.job &&
              entry.phase === "running" &&
              entry.pump
                ? {
                    ...entry,
                    pump: decideWorkspacePump(entry.pump, {
                      type: "CLAIMED",
                      claim: args.event.claim,
                    }),
                  }
                : entry
            ),
          },
        }
      },
      DEFER_CLEANUP: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) =>
            entry.token === args.event.token && entry.job === args.event.job
        )
        const pump = owned?.pump
          ? decideWorkspacePump(owned.pump, {
              type: "DEFER_CLEANUP",
              at: args.event.at,
            })
          : null
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, permission: "start", pump, at: 0 },
        })
        return {
          context: {
            ...args.context,
            entries: args.context.entries.map((entry) =>
              entry === owned ? { ...entry, pump } : entry
            ),
          },
        }
      },
      FINISHED: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) =>
            entry.token === args.event.token && entry.job === args.event.job
        )
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission: !open(args.value)
              ? "stopped"
              : owned?.wakeRequested
                ? "rearm"
                : "schedule",
            pump: null,
            at: 0,
          },
        })
        return {
          context: {
            ...args.context,
            entries: args.event.retain
              ? args.context.entries.map((entry) =>
                  entry === owned
                    ? { ...entry, phase: "retained" as const }
                    : entry
                )
              : args.context.entries.filter((entry) => entry !== owned),
          },
        }
      },
      FAILED: (args, enq) => {
        enq(args.actions.closed, { ...args, params: args.event.ack })
        return {
          context: {
            ...args.context,
            entries: args.context.entries.map((entry) =>
              entry.token === args.event.token &&
              entry.job === args.event.job &&
              entry.phase === "running"
                ? {
                    ...entry,
                    phase: "failed" as const,
                    pump: entry.pump
                      ? decideWorkspacePump(entry.pump, {
                          type: "FAILED",
                          now: args.event.now,
                        })
                      : null,
                  }
                : entry
            ),
          },
        }
      },
    },
    states: {
      admission: {
        initial: "open",
        on: {
          CLOSE: (args, enq) => {
            enq(args.actions.closed, { ...args, params: args.event.ack })
            for (const reply of args.context.waiting)
              enq(args.actions.respond, {
                ...args,
                params: { reply, permission: "stopped", pump: null, at: 0 },
              })
            return {
              target: ".closed",
              context: { ...args.context, waiting: [] },
            }
          },
        },
        states: { open: {}, closed: {} },
      },
      scheduling: {
        initial: "idle",
        states: {
          idle: {
            on: {
              SCHEDULE: (args, enq) => {
                enq(args.actions.respond, {
                  ...args,
                  params: {
                    reply: args.event.reply,
                    permission: open(args.value) ? "start" : "stopped",
                    pump: null,
                    at: 0,
                  },
                })
                if (open(args.value)) return { target: "held" }
              },
            },
          },
          held: {
            on: {
              SCHEDULE: (args, enq) => {
                if (!open(args.value)) {
                  enq(args.actions.respond, {
                    ...args,
                    params: {
                      reply: args.event.reply,
                      permission: "stopped",
                      pump: null,
                      at: 0,
                    },
                  })
                  return
                }
                return {
                  context: {
                    ...args.context,
                    waiting: [...args.context.waiting, args.event.reply],
                  },
                }
              },
              RELEASE: (args, enq) => {
                enq(args.actions.closed, { ...args, params: args.event.ack })
                const [next, ...waiting] = args.context.waiting
                if (next)
                  enq(args.actions.respond, {
                    ...args,
                    params: {
                      reply: next,
                      permission: "start",
                      pump: null,
                      at: 0,
                    },
                  })
                return {
                  target: next ? "held" : "idle",
                  context: { ...args.context, waiting },
                }
              },
            },
          },
        },
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
                            new Error(
                              "Invalid Workspace restoration generation"
                            )
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
                            new Error(
                              "Invalid Workspace restoration generation"
                            )
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
                            new Error(
                              "Invalid Workspace restoration generation"
                            )
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
