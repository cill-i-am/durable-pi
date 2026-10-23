import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { ReplyProgress, ReplyMessage, replyComplete } from "./contracts"

const { state: _, ...fields } = ReplyMessage.fields
const Context = Schema.Struct(fields)
const change = (context: typeof Context.Type) => ({
  ...context,
  revision: context.revision + 1,
})
const same = (left: unknown, right: unknown) =>
  JSON.stringify(left) === JSON.stringify(right)
const owned = (context: typeof Context.Type, attemptId: string) =>
  context.attemptId === attemptId

export const replyMessageMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      ADMIT: Schema.Struct({
        prepared: Schema.Boolean,
        expired: Schema.Boolean,
        error: Schema.NullOr(Schema.String),
      }),
      PREPARED: Schema.Struct({
        reply: Schema.String,
        revision: Schema.UndefinedOr(Schema.Number),
      }),
      WORK_CHECKED: Schema.Struct({ now: Schema.Number, error: Schema.String }),
      WORK_RENEWED: Schema.Struct({
        revision: Schema.Number,
        now: Schema.Number,
        deadline: Schema.Number,
      }),
      CANCEL: Schema.Struct({ error: Schema.String }),
      EXPIRE: Schema.Struct({
        error: Schema.String,
        expired: Schema.Boolean,
        revision: Schema.UndefinedOr(Schema.Number),
      }),
      PREPARATION_FAILED: Schema.Struct({
        error: Schema.String,
        revision: Schema.UndefinedOr(Schema.Number),
      }),
      PREPARATION_STARTED: Schema.Struct({
        revision: Schema.UndefinedOr(Schema.Number),
        attempts: Schema.Number,
        limit: Schema.Number,
        error: Schema.String,
      }),
      PREPARATION_SAVED: Schema.Struct({ revision: Schema.Number }),
      CLAIM: Schema.Struct({
        from: Schema.Literals(["waiting", "sending"]),
        attemptId: Schema.String,
        now: Schema.Number,
        deadline: Schema.Number,
        reply: Schema.String,
        delivery: Schema.NullOr(ReplyProgress),
        authorized: Schema.Boolean,
        expired: Schema.Boolean,
        error: Schema.String,
      }),
      CHECKPOINT: Schema.Struct({
        attemptId: Schema.String,
        delivery: ReplyProgress,
      }),
      FINISH: Schema.Struct({
        attemptId: Schema.String,
        state: Schema.Literals(["sent", "failed", "uncertain"]),
        providerId: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
      }),
      RECOVER: Schema.Struct({
        now: Schema.Number,
        force: Schema.Boolean,
        attemptId: Schema.NullOr(Schema.String),
        error: Schema.String,
      }),
      RECOVERY_EXHAUSTED: Schema.Struct({
        now: Schema.Number,
        error: Schema.String,
        expiredOnly: Schema.UndefinedOr(Schema.Boolean),
      }),
      RETRY: Schema.Struct({
        waiting: Schema.Boolean,
        acknowledgeDuplicateRisk: Schema.Boolean,
        deadline: Schema.Number,
      }),
    },
  },
}).createMachine({
  id: "reply-message",
  version: "1",
  context: ({ input }) => input,
  initial: "absent",
  states: {
    absent: {
      on: {
        ADMIT: ({ context, event }) => ({
          target: event.expired
            ? "expired"
            : event.prepared
              ? "waiting"
              : "queued",
          context: { ...context, error: event.error },
        }),
      },
    },
    queued: {
      on: {
        WORK_CHECKED: ({ context, event }) =>
          context.workDeadline === null || context.workDeadline <= event.now
            ? {
                target: "failed",
                context: { ...change(context), error: event.error },
              }
            : undefined,
        WORK_RENEWED: ({ context, event }) =>
          context.revision === event.revision &&
          context.workDeadline !== null &&
          context.workDeadline > event.now &&
          event.deadline > event.now
            ? {
                context: {
                  ...change(context),
                  workDeadline: Math.max(context.workDeadline, event.deadline),
                },
              }
            : undefined,
        RECOVERY_EXHAUSTED: ({ context, event }) =>
          event.expiredOnly &&
          context.workDeadline !== null &&
          context.workDeadline > event.now
            ? undefined
            : {
                target: "failed",
                context: { ...change(context), error: event.error },
              },
        PREPARED: ({ context, event }) =>
          event.revision !== undefined && context.revision !== event.revision
            ? undefined
            : {
                target: "waiting",
                context: { ...change(context), reply: event.reply },
              },
        CANCEL: ({ context, event }) => ({
          target: "cancelled",
          context: { ...change(context), error: event.error },
        }),
        EXPIRE: ({ context, event }) =>
          !event.expired ||
          (event.revision !== undefined && context.revision !== event.revision)
            ? undefined
            : {
                target: "expired",
                context: { ...change(context), error: event.error },
              },
        PREPARATION_FAILED: ({ context, event }) => {
          if (
            event.revision !== undefined &&
            event.revision !== context.revision
          )
            return
          return {
            target: "failed",
            context: { ...change(context), error: event.error },
          }
        },
        PREPARATION_STARTED: ({ context, event }) =>
          event.revision !== undefined && context.revision !== event.revision
            ? undefined
            : event.attempts >= event.limit
              ? {
                  target: "failed",
                  context: { ...change(context), error: event.error },
                }
              : { context: change(context) },
        PREPARATION_SAVED: ({ context, event }) =>
          event.revision === context.revision
            ? { context: change(context) }
            : undefined,
      },
    },
    waiting: {
      on: {
        WORK_CHECKED: ({ context, event }) =>
          context.workDeadline === null || context.workDeadline <= event.now
            ? {
                target: "failed",
                context: { ...change(context), error: event.error },
              }
            : undefined,
        WORK_RENEWED: ({ context, event }) =>
          context.revision === event.revision &&
          context.workDeadline !== null &&
          context.workDeadline > event.now &&
          event.deadline > event.now
            ? {
                context: {
                  ...change(context),
                  workDeadline: Math.max(context.workDeadline, event.deadline),
                },
              }
            : undefined,
        RECOVERY_EXHAUSTED: ({ context, event }) =>
          event.expiredOnly &&
          context.workDeadline !== null &&
          context.workDeadline > event.now
            ? undefined
            : {
                target: "failed",
                context: { ...change(context), error: event.error },
              },
        CANCEL: ({ context, event }) => ({
          target: "cancelled",
          context: { ...change(context), error: event.error },
        }),
        EXPIRE: ({ context, event }) =>
          !event.expired ||
          (event.revision !== undefined && context.revision !== event.revision)
            ? undefined
            : {
                target: "expired",
                context: { ...change(context), error: event.error },
              },
        CLAIM: ({ context, event }) => {
          if (
            event.from !== "waiting" ||
            event.deadline <= event.now ||
            (context.workDeadline !== null && context.workDeadline <= event.now)
          )
            return
          if (!event.authorized)
            return {
              target: "cancelled",
              context: { ...change(context), error: event.error },
            }
          if (event.expired)
            return {
              target: "expired",
              context: { ...change(context), error: event.error },
            }
          if (context.delivery && !same(context.delivery, event.delivery))
            throw new Error("Frozen reply plan or receipts changed")
          return {
            target: "sending",
            context: {
              ...change(context),
              reply: event.reply,
              delivery: event.delivery,
              attemptId: event.attemptId,
              sendIndex: event.delivery?.receipts.length ?? 0,
              sendDeadline: event.deadline,
              error: null,
            },
          }
        },
      },
    },
    sending: {
      on: {
        RECOVERY_EXHAUSTED: ({ context, event }) => {
          if (context.sendDeadline !== null && context.sendDeadline > event.now)
            return
          const complete = replyComplete(context.delivery)
          return {
            target: complete ? "sent" : "uncertain",
            context: {
              ...change(context),
              providerId: complete ? context.delivery!.receipts.at(-1)! : null,
              error: complete ? null : event.error,
            },
          }
        },
        CLAIM: ({ context, event }) => {
          if (
            event.from !== "sending" ||
            !owned(context, event.attemptId) ||
            event.deadline <= event.now
          )
            return
          if (
            !context.delivery ||
            context.sendIndex === null ||
            context.sendIndex >= context.delivery.receipts.length
          )
            return
          if (!same(context.delivery, event.delivery))
            throw new Error("Frozen reply plan or receipts changed")
          if (!event.authorized)
            return {
              target: "cancelled",
              context: { ...change(context), error: event.error },
            }
          if (event.expired)
            return {
              target: "expired",
              context: { ...change(context), error: event.error },
            }
          return {
            context: {
              ...change(context),
              sendIndex: context.delivery.receipts.length,
              sendDeadline: event.deadline,
            },
          }
        },
        CHECKPOINT: ({ context, event }) => {
          if (!owned(context, event.attemptId)) return
          if (
            !context.delivery ||
            context.sendIndex !== context.delivery.receipts.length
          )
            return
          if (
            event.delivery.receipts.length !==
              context.delivery.receipts.length + 1 ||
            !same(
              {
                ...event.delivery,
                receipts: event.delivery.receipts.slice(0, -1),
              },
              context.delivery
            )
          )
            throw new Error("Reply checkpoint does not extend the claimed part")
          return { context: { ...change(context), delivery: event.delivery } }
        },
        FINISH: ({ context, event }) => {
          if (!owned(context, event.attemptId)) return
          if (event.state === "sent" && !replyComplete(context.delivery))
            throw new Error("Reply is missing provider receipts")
          if (
            event.state === "sent" &&
            event.providerId !== context.delivery!.receipts.at(-1)
          )
            throw new Error("Reply completion does not match the saved receipt")
          return {
            target: event.state,
            context: {
              ...change(context),
              providerId: event.providerId,
              error: event.error,
            },
          }
        },
        RECOVER: ({ context, event }) => {
          if (event.attemptId !== null && !owned(context, event.attemptId))
            return
          if (
            !event.force &&
            context.sendDeadline !== null &&
            context.sendDeadline > event.now
          )
            return
          const complete = replyComplete(context.delivery)
          return {
            target: complete ? "sent" : "uncertain",
            context: {
              ...change(context),
              providerId: complete ? context.delivery!.receipts.at(-1)! : null,
              error: complete ? null : event.error,
            },
          }
        },
      },
    },
    sent: {},
    cancelled: {},
    failed: {
      on: {
        RETRY: ({ context, event }) => ({
          target: event.waiting ? "waiting" : "queued",
          context: {
            ...change(context),
            error: null,
            attemptId: null,
            sendIndex: null,
            sendDeadline: null,
            workDeadline: event.deadline,
          },
        }),
      },
    },
    expired: {
      on: {
        RETRY: ({ context, event }) => ({
          target: event.waiting ? "waiting" : "queued",
          context: {
            ...change(context),
            error: null,
            attemptId: null,
            sendIndex: null,
            sendDeadline: null,
            workDeadline: event.deadline,
          },
        }),
      },
    },
    uncertain: {
      on: {
        RETRY: ({ context, event }) => {
          if (!event.acknowledgeDuplicateRisk) return
          return {
            target: event.waiting ? "waiting" : "queued",
            context: {
              ...change(context),
              error: null,
              attemptId: null,
              sendIndex: null,
              sendDeadline: null,
              workDeadline: event.deadline,
            },
          }
        },
      },
    },
  },
})
export type ReplyMessageEvent = EventFromLogic<typeof replyMessageMachine>
function step(
  snapshot: ReturnType<typeof replyMessageMachine.resolveState>,
  event: ReplyMessageEvent
): ReplyMessage {
  const [next, effects] = transition(replyMessageMachine, snapshot, event)
  if (effects.length)
    throw new Error(`Unsupported durable reply effect: ${effects[0]!.type}`)
  return validateReplyMessage({
    ...next.context,
    state: next.value,
  })
}
export function newReplyMessage(
  reply: string,
  prepared = false,
  expired = false,
  error: string | null = null,
  workDeadline: number | null = null
) {
  const [initial, effects] = initialTransition(replyMessageMachine, {
    schemaVersion: 1,
    workflowVersion: 1,
    revision: 0,
    attemptId: null,
    sendIndex: null,
    sendDeadline: null,
    workDeadline,
    reply,
    delivery: null,
    providerId: null,
    error: null,
  })
  if (effects.length) throw new Error("Unsupported reply initialization effect")
  return step(initial, { type: "ADMIT", prepared, expired, error })
}
export function advanceReplyMessage(saved: unknown, event: ReplyMessageEvent) {
  const { state, ...context } = validateReplyMessage(saved)
  return step(
    replyMessageMachine.resolveState({ value: state, context }),
    event
  )
}

function validateReplyMessage(saved: unknown) {
  const value = Schema.decodeUnknownSync(ReplyMessage)(saved)
  if (
    value.delivery &&
    (value.delivery.receipts.length > value.delivery.parts.length ||
      !value.delivery.parts.length)
  )
    throw new Error("Invalid persisted reply progress")
  return value
}
