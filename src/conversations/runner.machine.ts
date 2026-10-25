import { createEffectLogic, setupEffect } from "@xstate/effect"
import { Deferred, Effect, Exit, Schema, type Scope } from "effect"
import { standardSchemaValidator } from "xstate/validation"

export type ConversationRestoreReply = Deferred.Deferred<void, unknown>
export type ConversationRunnerAck = Deferred.Deferred<void>
const reply = Schema.declare((value): value is ConversationRestoreReply =>
  Deferred.isDeferred(value)
)
const ack = Schema.declare((value): value is ConversationRunnerAck =>
  Deferred.isDeferred(value)
)
const result = Schema.Struct({
  replies: Schema.Array(reply),
  exit: Schema.declare((value): value is Exit.Exit<void, unknown> =>
    Exit.isExit(value)
  ),
})

export const ConversationControlAttempt = Schema.Struct({
  rootId: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  phase: Schema.Literals(["handoff", "observe", "stop"]),
})
export type ConversationControlAttempt = typeof ConversationControlAttempt.Type
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
  receipt: Schema.NullOr(ConversationControlAttempt),
})
export type ConversationRunnerDecision = typeof decision.Type
export type ConversationRunnerReply =
  Deferred.Deferred<ConversationRunnerDecision>
const decisionReply = Schema.declare(
  (value): value is ConversationRunnerReply => Deferred.isDeferred(value)
)
const response = Schema.Struct({ reply: decisionReply, ...decision.fields })
const job = Schema.declare(
  (value): value is object => typeof value === "object" && value !== null
)
const entry = Schema.Struct({
  token: Schema.NonEmptyString,
  job,
  phase: Schema.Literals(["running", "failed", "exhausting"]),
  receipt: Schema.NullOr(ConversationControlAttempt),
  wakeRequested: Schema.Boolean,
})
function open(value: import("xstate").StateValue) {
  return typeof value === "object" && value.admission === "open"
}

/** Local callback and activation authority. Domain receipts, SQL revisions and
 * Lifecycle remain the durable owners; this machine never grants a new retry. */
export function conversationRunnerMachine<E>(
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
          reply: decisionReply,
        }),
        ERROR: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          current: Schema.Boolean,
          reply: decisionReply,
        }),
        WAKE: Schema.Struct({
          token: Schema.NullOr(Schema.NonEmptyString),
          reply: decisionReply,
        }),
        RECEIPT: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          receipt: ConversationControlAttempt,
        }),
        FINISHED: Schema.Struct({
          token: Schema.NonEmptyString,
          job,
          reply: decisionReply,
        }),
        FAILED: Schema.Struct({ token: Schema.NonEmptyString, job, ack }),
        EXHAUSTED: Schema.Struct({ token: Schema.NonEmptyString, job, ack }),
      },
    },
    actions: {
      respond: ({ params }: { params?: unknown }) => {
        const value = Schema.decodeUnknownSync(response)(params)
        return Deferred.succeed(value.reply, {
          permission: value.permission,
          receipt: value.receipt,
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
    id: "conversation-runner",
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
        const scheduling =
          typeof args.value === "object" && args.value.scheduling === "held"
        const permission = !open(args.value)
          ? "stopped"
          : !args.event.current
            ? "stale"
            : scheduling ||
                (owned &&
                  (owned.job !== args.event.job || owned.phase !== "failed"))
              ? "defer"
              : "start"
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, permission, receipt: null },
        })
        if (permission === "start")
          return {
            context: {
              ...args.context,
              entries: [
                ...args.context.entries.filter(
                  (entry) => entry.token !== args.event.token
                ),
                {
                  token: args.event.token,
                  job: args.event.job,
                  phase: "running" as const,
                  receipt: owned?.receipt ?? null,
                  wakeRequested: owned?.wakeRequested ?? false,
                },
              ],
            },
          }
      },
      ERROR: (args, enq) => {
        const owned = args.context.entries.find(
          (entry) =>
            entry.token === args.event.token && entry.job === args.event.job
        )
        const permission = !open(args.value)
          ? "stopped"
          : args.event.current && owned?.phase === "failed"
            ? "start"
            : "stale"
        enq(args.actions.respond, {
          ...args,
          params: {
            reply: args.event.reply,
            permission,
            receipt: permission === "start" ? owned!.receipt : null,
          },
        })
        if (permission === "start")
          return {
            context: {
              ...args.context,
              entries: args.context.entries.map((entry) =>
                entry === owned
                  ? { ...entry, phase: "exhausting" as const }
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
            : owned
              ? "rearm"
              : "schedule"
        enq(args.actions.respond, {
          ...args,
          params: { reply: args.event.reply, permission, receipt: null },
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
      RECEIPT: ({ context, event }) => ({
        context: {
          ...context,
          entries: context.entries.map((entry) =>
            entry.token === event.token &&
            entry.job === event.job &&
            entry.phase === "running"
              ? { ...entry, receipt: event.receipt }
              : entry
          ),
        },
      }),
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
            receipt: null,
          },
        })
        return {
          context: {
            ...args.context,
            entries: args.context.entries.filter((entry) => entry !== owned),
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
                ? { ...entry, phase: "failed" as const }
                : entry
            ),
          },
        }
      },
      EXHAUSTED: (args, enq) => {
        enq(args.actions.closed, { ...args, params: args.event.ack })
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
                params: { reply, permission: "stopped", receipt: null },
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
                    receipt: null,
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
                      receipt: null,
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
                    params: { reply: next, permission: "start", receipt: null },
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
                              "Invalid Conversation restoration generation"
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
                              "Invalid Conversation restoration generation"
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
                              "Invalid Conversation restoration generation"
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
