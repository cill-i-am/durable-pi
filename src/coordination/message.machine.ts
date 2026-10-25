import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

const integer = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
export const MessagePhase = Schema.Literals([
  "pending",
  "dispatching",
  "delivered",
  "failed",
  "unconfirmed",
])
export const MessageControl = Schema.Struct({
  schema_version: Schema.Literal(1),
  workflow_version: Schema.Literal(1),
  revision: integer,
  phase: MessagePhase,
  attempts: integer,
  retry_at: integer,
  error: Schema.NullOr(Schema.String),
  attempt_id: Schema.NullOr(Schema.String),
})
export type MessageControl = typeof MessageControl.Type
const Context = Schema.Struct({
  ...MessageControl.fields,
  deadline: integer,
})
const attempt = Schema.String.check(Schema.isNonEmpty())
const events = {
  CLAIM: Schema.Struct({ now: integer, attempt }),
  ACCEPTED: Schema.Struct({ attempt }),
  RETRY: Schema.Struct({ now: integer, attempt }),
  REJECTED: Schema.Struct({ attempt, error: Schema.String }),
  CLOSE: Schema.Struct({ error: Schema.String }),
  EXPIRE: Schema.Struct({ now: integer }),
  RESTORE: Schema.Struct({ now: integer }),
  EXHAUST: Schema.Struct({ error: Schema.String }),
}
const close = ({
  context,
  event,
}: {
  context: typeof Context.Type
  event: { error: string }
}) => ({
  target: context.phase === "dispatching" ? "unconfirmed" : "failed",
  context: { ...context, error: event.error },
})

/** The existing message row owns acceptance and uncertainty. Pi owns the
 * recipient's work; delivered means native/Conversations acceptance only. */
export const coordinationMessageMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { input: Context, context: Context, events },
}).createMachine({
  id: "coordination-message",
  version: "1",
  initial: "pending",
  context: ({ input }) => input,
  states: {
    pending: {
      on: {
        CLAIM: ({ context, event }) => {
          if (event.now < context.retry_at) return
          if (event.now >= context.deadline)
            return {
              target: "failed",
              context: {
                ...context,
                error: "Message expired before delivery.",
              },
            }
          return {
            target: "dispatching",
            context: { ...context, attempt_id: event.attempt },
          }
        },
        CLOSE: close,
        EXHAUST: close,
        EXPIRE: ({ context, event }) =>
          event.now >= context.deadline
            ? {
                target: "failed",
                context: {
                  ...context,
                  error: "Message expired before delivery.",
                },
              }
            : undefined,
      },
    },
    dispatching: {
      on: {
        ACCEPTED: ({ context, event }) =>
          event.attempt === context.attempt_id
            ? {
                target: "delivered",
                context: { ...context, error: null, attempt_id: null },
              }
            : undefined,
        RETRY: ({ context, event }) => {
          if (event.attempt !== context.attempt_id) return
          if (context.attempts >= 7 || event.now >= context.deadline)
            return {
              target: "unconfirmed",
              context: {
                ...context,
                error:
                  context.attempts >= 7
                    ? "Delivery could not be confirmed after eight attempts."
                    : "Message expired before delivery could be confirmed.",
              },
            }
          return {
            target: "pending",
            context: {
              ...context,
              attempt_id: null,
              attempts: context.attempts + 1,
              retry_at: Math.min(
                context.deadline,
                event.now + Math.min(30000, 1000 * 2 ** context.attempts)
              ),
            },
          }
        },
        REJECTED: ({ context, event }) =>
          event.attempt === context.attempt_id
            ? {
                target: "failed",
                context: { ...context, error: event.error, attempt_id: null },
              }
            : undefined,
        CLOSE: close,
        EXHAUST: close,
        RESTORE: ({ context, event }) => ({
          target: "pending",
          context: { ...context, attempt_id: null, retry_at: event.now },
        }),
      },
    },
    delivered: {},
    failed: {},
    unconfirmed: {},
  },
})
export type MessageEvent = EventFromLogic<typeof coordinationMessageMachine>
export function advanceMessage(
  raw: MessageControl,
  deadline: number,
  event: MessageEvent
) {
  const current = Schema.decodeUnknownSync(Context)({ ...raw, deadline })
  if (!Object.hasOwn(events, event.type))
    throw new Error("Invalid coordination message event")
  const { type, ...payload } = event
  Schema.decodeUnknownSync(events[type], { onExcessProperty: "error" })(payload)
  const [next, effects] = transition(
    coordinationMessageMachine,
    coordinationMessageMachine.resolveState({
      value: current.phase,
      context: current,
    }),
    event
  )
  if (effects.length)
    throw new Error(
      `Unsupported coordination message effect: ${effects[0]!.type}`
    )
  if (
    next.value === current.phase &&
    JSON.stringify(next.context) === JSON.stringify(current)
  )
    return undefined
  return Schema.decodeUnknownSync(MessageControl)({
    ...next.context,
    phase: next.value,
    revision: current.revision + 1,
  })
}
export const messageStatus = (control: Pick<MessageControl, "phase">) =>
  control.phase === "delivered"
    ? ("delivered" as const)
    : control.phase === "pending" || control.phase === "dispatching"
      ? ("accepted" as const)
      : ("failed" as const)
