import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import {
  CONTROL_ATTEMPTS,
  LEASE_MS,
  STOP_ATTEMPTS,
  STOP_DEADLINE_MS,
  ControlAttempt,
  Envelope,
  Outcome,
  Task,
  TaskRelease,
  failure,
  terminal,
  type TaskClaim,
} from "./contracts"

const time = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const { status: _, ...fields } = Task.fields
const Context = Schema.toType(Schema.Struct(fields))
type Context = typeof Context.Type
const bump = (context: Context) => ({
  ...context,
  revision: context.revision + 1,
})
const stopPending = (context: Context, now: number) =>
  context.stop.status === "none"
    ? {
        status: "pending" as const,
        attempts: 0,
        deadline: now + STOP_DEADLINE_MS,
        nextAt: now,
      }
    : context.stop
const finished = (context: Context, outcome: Outcome) => ({
  target: `.${outcome.status}`,
  context: { ...bump(context), outcome, leaseUntil: null },
})
const canFinish = (
  context: Context,
  revision: number,
  owner: string,
  outcome: Outcome,
  now: number
) =>
  context.direction === "incoming" &&
  context.revision === revision &&
  context.control.owner === owner &&
  (!context.cancelRequested ||
    outcome.status === "cancelled" ||
    outcome.status === "expired") &&
  (now < context.request.deadline ||
    outcome.status === "cancelled" ||
    outcome.status === "expired")

const stopExhausted = (stop: Context["stop"], now: number) =>
  stop.attempts >= STOP_ATTEMPTS || now >= (stop.deadline ?? Infinity)
const unavailable = (context: Context, now: number, deadline: number) =>
  context.direction !== "incoming" ||
  context.control.owner !== null ||
  (context.control.unconfirmed && context.stop.status !== "pending") ||
  context.stop.status === "unconfirmed" ||
  deadline <= now
const outcomeAdmitted = (context: Context, event: TaskRelease) =>
  event.outcome !== undefined &&
  context.outcome === null &&
  canFinish(context, event.revision, event.owner, event.outcome, event.now)

const continuationExhausted = (context: Context, failed = true) =>
  context.control.unconfirmed ||
  (failed && !context.resumed && context.control.attempts >= CONTROL_ATTEMPTS)

export const communicationTaskMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    context: Context,
    input: Schema.toType(
      Schema.Struct({
        request: Envelope,
        direction: Task.fields.direction,
      })
    ),
    events: {
      CLAIM: Schema.Struct({
        now: time,
        owner: ControlAttempt.fields.owner,
        deadline: time,
      }),
      CLAIM_CONTINUATION: Schema.Struct({
        now: time,
        owner: ControlAttempt.fields.owner,
        deadline: time,
      }),
      RETRY_CONTINUATION: Schema.Struct({}),
      CANCEL: Schema.Struct({ now: time }),
      BEFORE_START_CANCEL: Schema.Struct({ now: time }),
      COMPLETE: Schema.Struct({
        revision: time,
        owner: ControlAttempt.fields.owner,
        outcome: Outcome,
        now: time,
      }),
      RESULT: Schema.Struct({ outcome: Outcome }),
      RELEASE: Schema.Struct({ receipt: TaskRelease }),
      RESTORE: Schema.Struct({ now: time }),
      EXHAUST: Schema.Struct({ ...ControlAttempt.fields, now: time }),
      CONSUME: Schema.Struct({
        taskId: ControlAttempt.fields.taskId,
        owner: Schema.NullOr(ControlAttempt.fields.owner),
        revision: time,
        discard: Schema.Boolean,
        phase: ControlAttempt.fields.phase,
      }),
      EXPIRE: Schema.Struct({ now: time }),
    },
  },
}).createMachine({
  id: "communication-task",
  version: "1",
  initial: "accepted",
  context: ({ input }) => ({
    schemaVersion: 1,
    workflowVersion: 1,
    id: input.request.taskId,
    request: input.request,
    direction: input.direction,
    outcome: null,
    revision: 0,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
    control: {
      owner: null,
      phase: "submit",
      deadline: null,
      attempts: 0,
      unconfirmed: false,
    },
    stop: { status: "none", attempts: 0, deadline: null, nextAt: null },
  }),
  on: {
    CLAIM: ({ context, event }) => {
      const isTerminal = context.outcome !== null
      const stopping = context.stop.status === "pending"
      if (unavailable(context, event.now, event.deadline)) return
      if (stopping && (context.stop.nextAt ?? 0) > event.now) return
      if (stopping && stopExhausted(context.stop, event.now))
        return {
          context: {
            ...bump(context),
            stop: { ...context.stop, status: "unconfirmed", nextAt: null },
          },
        }
      if (
        !stopping &&
        (isTerminal ||
          (context.leaseUntil !== null && context.leaseUntil > event.now))
      )
        return
      const phase =
        stopping || context.cancelRequested ? "stop" : context.control.phase
      return {
        target: isTerminal
          ? undefined
          : context.cancelRequested
            ? ".cancelling"
            : ".running",
        context: {
          ...bump(context),
          leaseUntil: event.now + LEASE_MS,
          control: {
            ...context.control,
            owner: event.owner,
            phase,
            deadline: event.deadline,
          },
          stop: stopping
            ? {
                ...context.stop,
                attempts: context.stop.attempts + 1,
                nextAt: null,
              }
            : context.stop,
        },
      }
    },
    CLAIM_CONTINUATION: ({ context, event }) => {
      if (
        context.direction !== "outgoing" ||
        context.outcome === null ||
        context.resumed ||
        context.control.owner !== null ||
        context.control.unconfirmed ||
        event.deadline <= event.now
      )
        return
      if (context.control.attempts >= CONTROL_ATTEMPTS)
        return {
          context: {
            ...bump(context),
            control: {
              ...context.control,
              phase: "continuation",
              unconfirmed: true,
            },
          },
        }
      return {
        context: {
          ...bump(context),
          control: {
            ...context.control,
            owner: event.owner,
            phase: "continuation",
            deadline: event.deadline,
            attempts: context.control.attempts + 1,
          },
        },
      }
    },
    RETRY_CONTINUATION: ({ context }) => {
      if (
        context.direction !== "outgoing" ||
        context.outcome === null ||
        context.resumed ||
        context.control.phase !== "continuation" ||
        context.control.owner !== null ||
        !context.control.unconfirmed
      )
        return
      return {
        context: {
          ...bump(context),
          control: {
            ...context.control,
            attempts: 0,
            unconfirmed: false,
            deadline: null,
          },
        },
      }
    },
    CANCEL: ({ context, event }) => {
      if (context.cancelRequested) return
      const isTerminal = context.outcome !== null
      return {
        target: isTerminal ? undefined : ".cancelling",
        context: {
          ...bump(context),
          cancelRequested: true,
          stop: stopPending(context, event.now),
        },
      }
    },
    COMPLETE: ({ context, event }) => {
      if (
        context.outcome !== null ||
        !canFinish(
          context,
          event.revision,
          event.owner,
          event.outcome,
          event.now
        )
      )
        return
      return finished(context, event.outcome)
    },
    RELEASE: ({ context, event: { receipt: event } }) => {
      if (context.id !== event.taskId || context.control.owner !== event.owner)
        return
      if (
        context.direction === "outgoing" &&
        context.control.phase === "continuation"
      )
        return {
          context: {
            ...bump(context),
            control: {
              ...context.control,
              owner: null,
              deadline: null,
              unconfirmed: continuationExhausted(
                context,
                event.failed === true
              ),
            },
          },
        }
      const isTerminal = context.outcome !== null
      const admits = outcomeAdmitted(context, event)
      const failures = event.failed ? context.control.attempts + 1 : 0
      const exhausted =
        context.control.unconfirmed || failures >= CONTROL_ATTEMPTS
      let stop = context.stop
      if (event.stop === "confirmed")
        stop = { ...stop, status: "confirmed", nextAt: null }
      else if (event.stop === "unconfirmed")
        stop = { ...stop, status: "unconfirmed", nextAt: null }
      else if (stop.status === "pending") {
        const done = stopExhausted(stop, event.now)
        stop = {
          ...stop,
          status: done ? "unconfirmed" : "pending",
          nextAt: done
            ? null
            : Math.min(
                event.now +
                  (event.failed
                    ? Math.min(60000, 1000 * 2 ** stop.attempts)
                    : 0),
                stop.deadline ?? Infinity
              ),
        }
      }
      return {
        target: admits ? `.${event.outcome!.status}` : undefined,
        context: {
          ...bump(context),
          outcome: admits ? event.outcome! : context.outcome,
          leaseUntil:
            admits || isTerminal || context.cancelRequested
              ? null
              : event.now + LEASE_MS,
          control: {
            owner: null,
            phase: context.cancelRequested ? "stop" : "observe",
            deadline: null,
            attempts: failures,
            unconfirmed: exhausted,
          },
          stop,
        },
      }
    },
    RESTORE: ({ context, event }) => {
      if (context.control.owner === null) return
      if (
        context.direction === "outgoing" &&
        context.control.phase === "continuation"
      )
        return {
          context: {
            ...bump(context),
            control: {
              ...context.control,
              owner: null,
              deadline: null,
              unconfirmed: continuationExhausted(context),
            },
          },
        }
      if (context.direction !== "incoming") return
      return {
        context: {
          ...bump(context),
          leaseUntil: null,
          control: {
            ...context.control,
            owner: null,
            deadline: null,
            phase:
              context.cancelRequested || context.stop.status === "pending"
                ? "stop"
                : "observe",
          },
          stop:
            context.stop.status === "pending"
              ? { ...context.stop, nextAt: event.now }
              : context.stop,
        },
      }
    },
    EXHAUST: ({ context, event }) => {
      if (
        context.id !== event.taskId ||
        context.control.owner !== event.owner ||
        context.revision !== event.revision ||
        context.control.phase !== event.phase
      )
        return
      return {
        context: {
          ...bump(context),
          control: {
            ...context.control,
            attempts: CONTROL_ATTEMPTS,
            unconfirmed: true,
          },
          stop:
            context.control.phase !== "continuation" &&
            context.stop.status === "pending"
              ? { ...context.stop, status: "unconfirmed", nextAt: null }
              : context.stop,
        },
      }
    },
    CONSUME: ({ context, event }) => {
      if (
        context.direction !== "outgoing" ||
        context.outcome === null ||
        context.resumed ||
        context.id !== event.taskId ||
        context.revision !== event.revision ||
        context.control.owner !== event.owner ||
        context.control.phase !== event.phase
      )
        return
      if (
        !event.discard &&
        (context.control.unconfirmed ||
          (context.control.phase === "continuation" && event.owner === null))
      )
        return
      return { context: { ...bump(context), resumed: true } }
    },
    RESULT: ({ context, event }) =>
      context.direction === "outgoing" && !(context.outcome !== null)
        ? finished(context, event.outcome)
        : undefined,
    EXPIRE: ({ context, event }) => {
      if (context.outcome !== null || event.now < context.request.deadline)
        return
      return {
        target: ".expired",
        context: {
          ...bump(context),
          outcome: {
            status: "expired",
            text: context.cancelRequested
              ? "Cancellation was requested; termination could not be confirmed before the deadline."
              : "The result was not confirmed before the task deadline.",
          },
          stop: context.cancelRequested
            ? stopPending(context, event.now)
            : context.stop,
        },
      }
    },
  },
  states: {
    accepted: {
      always: ({ context }) =>
        context.direction === "outgoing" ? { target: "waiting" } : undefined,
      on: {
        BEFORE_START_CANCEL: ({ context }) => ({
          target: "cancelled",
          context: {
            ...bump(context),
            cancelRequested: true,
            outcome: {
              status: "cancelled",
              text: "Cancelled before execution.",
            },
            stop: {
              status: "confirmed",
              attempts: 0,
              deadline: null,
              nextAt: null,
            },
          },
        }),
      },
    },
    running: {},
    waiting: {},
    cancelling: {},
    completed: {},
    failed: {},
    expired: {},
    cancelled: {},
    awaiting_input: {},
  },
})

export type TaskEvent = EventFromLogic<typeof communicationTaskMachine>
export function advanceTask(raw: Task, event: TaskEvent): Task {
  const { status, ...context } = Schema.decodeUnknownSync(Task)(raw)
  const [next, effects] = transition(
    communicationTaskMachine,
    communicationTaskMachine.resolveState({ value: status, context }),
    event
  )
  if (effects.length)
    throw failure("invalid", "Invalid communication task event.")
  return Schema.decodeUnknownSync(Task)({ ...next.context, status: next.value })
}
export function newTask(request: Envelope, direction: Task["direction"]): Task {
  const [next, effects] = initialTransition(communicationTaskMachine, {
    request,
    direction,
  })
  if (effects.length)
    throw failure("invalid", "Invalid communication task event.")
  return Schema.decodeUnknownSync(Task)({ ...next.context, status: next.value })
}
export function claimTask(
  task: Task,
  now: number,
  options: TaskClaim
): Task | undefined {
  const next = advanceTask(task, { type: "CLAIM", now, ...options })
  return next.revision === task.revision ? undefined : next
}
export function requireFinish(
  task: Task,
  revision: number,
  outcome: Outcome,
  now: number,
  owner: string
) {
  const next = advanceTask(task, {
    type: "COMPLETE",
    revision,
    outcome,
    now,
    owner,
  })
  if (next.revision !== task.revision) return next
  if (
    !terminal(task) &&
    now >= task.request.deadline &&
    outcome.status !== "cancelled" &&
    outcome.status !== "expired"
  )
    throw failure("expired", "The task deadline has passed.")
  throw failure("stale", "This execution no longer owns the task.")
}
