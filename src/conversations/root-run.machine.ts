import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition, type EventFromLogic } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { advanceInput } from "./input.machine"
import {
  ConversationControl,
  conversationControlAttemptLimit,
  conversationControl,
  emptyConversationControl,
  type ControlRelease,
  type Turn,
  type TurnOutcome,
} from "./turns"

const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Phase = Schema.Literals(["handoff", "observe", "stop"])
const Context = Schema.Struct({
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  revision: Revision,
  control: ConversationControl,
  answer: Schema.String,
  error: Schema.NullOr(Schema.String),
})
type RootContext = typeof Context.Type
const events = {
  PREPARE: Schema.Struct({}),
  SUBMITTED: Schema.Struct({}),
  STEER: Schema.Struct({}),
  STOP: Schema.Struct({
    now: Schema.Number,
    discoveryDeadline: Schema.NullOr(Schema.Number),
    expectedRevision: Schema.NullOr(Revision),
    error: Schema.String,
  }),
  RETRY_STOP: Schema.Struct({
    now: Schema.Number,
    discoveryDeadline: Schema.Number,
    expectedRevision: Revision,
  }),
  CLAIM: Schema.Struct({
    owner: Schema.String,
    deadline: Schema.Number,
    now: Schema.Number,
    mode: Schema.Literals(["automatic", "inspect", "stop"]),
    expectedRevision: Schema.NullOr(Revision),
  }),
  RELEASE: Schema.Struct({
    owner: Schema.String,
    confirmed: Schema.Boolean,
    result: Schema.UndefinedOr(
      Schema.Struct({
        failed: Schema.Boolean,
        phase: Phase,
        timedOut: Schema.Boolean,
        inspected: Schema.Boolean,
        error: Schema.optional(Schema.String),
      })
    ),
  }),
  EXHAUST: Schema.Struct({
    expectedRevision: Revision,
    phase: Phase,
    error: Schema.String,
    eligible: Schema.Boolean,
  }),
  RESTORE: Schema.Struct({}),
  COMPLETE: Schema.Struct({
    expectedRevision: Revision,
    owner: Schema.NullOr(Schema.String),
    memberIds: Schema.Array(Schema.String),
    outcomes: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        delivery: Schema.Literals(["answered", "unanswered"]),
      })
    ),
    answer: Schema.String,
    error: Schema.NullOr(Schema.String),
  }),
  FINISH_MEMBER: Schema.Struct({
    delivery: Schema.Literals(["answered", "unanswered"]),
    stopped: Schema.Boolean,
  }),
}
const changed = (context: RootContext) => ({
  ...context,
  revision: context.revision + 1,
})
const finishStatus = (
  root: boolean,
  stopped: boolean,
  delivery: TurnOutcome["delivery"]
) =>
  root && stopped
    ? "cancelled"
    : delivery === "answered"
      ? "done"
      : stopped
        ? "cancelled"
        : "failed"
function release(
  context: RootContext,
  event: typeof events.RELEASE.Type,
  status?: "queued" | "preparing" | "running" | "stopping"
) {
  if (context.control.owner !== event.owner) return
  const result: ControlRelease = event.result ?? {
    failed: false,
    timedOut: false,
    inspected: false,
    phase: "observe",
  }
  if (status === "stopping" && result.phase !== "stop")
    return {
      context: {
        ...context,
        control: {
          ...context.control,
          owner: null,
          deadline: null,
          attempts:
            context.control.unconfirmed === null
              ? 0
              : (context.control.attempts ?? 0),
        },
      },
    }
  return releaseOutcome(context, event.confirmed, result, status)
}
function releaseOutcome(
  context: RootContext,
  nativeConfirmed: boolean,
  result: ControlRelease,
  status?: "queued" | "preparing" | "running" | "stopping"
) {
  const attempts = context.control.attempts ?? 0
  const failed = result.failed || result.timedOut
  const mark =
    status !== undefined &&
    (result.timedOut || (failed && attempts >= conversationControlAttemptLimit))
  const phase = status === "stopping" ? "stop" : result.phase
  const confirmed = nativeConfirmed && !failed
  return {
    context: {
      ...context,
      error: mark
        ? (result.error ??
          "Reply control could not be confirmed. Check the reply or retry Stop.")
        : status !== undefined &&
            confirmed &&
            context.control.unconfirmed !== null
          ? null
          : context.error,
      control: {
        ...context.control,
        owner: null,
        deadline: null,
        attempts: failed || (result.inspected && !confirmed) ? attempts : 0,
        unconfirmed: mark
          ? phase
          : confirmed
            ? null
            : context.control.unconfirmed,
      },
    },
  }
}
const pending = (status: "queued" | "preparing" | "running" | "stopping") => ({
  RELEASE: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.RELEASE.Type
  }) => release(context, event, status),
  CLAIM: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.CLAIM.Type
  }) => {
    if (
      context.parent !== null ||
      context.control.owner !== null ||
      !event.owner ||
      event.deadline <= event.now ||
      (event.expectedRevision !== null &&
        context.revision !== event.expectedRevision) ||
      (event.mode !== "inspect" &&
        (context.control.attempts ?? 0) >= conversationControlAttemptLimit) ||
      (event.mode === "automatic" && context.control.unconfirmed !== null) ||
      (event.mode === "stop" && status !== "stopping")
    )
      return
    return {
      context: {
        ...changed(context),
        control: {
          ...context.control,
          owner: event.owner,
          deadline: event.deadline,
          attempts:
            (context.control.attempts ?? 0) +
            (event.mode === "inspect" ? 0 : 1),
        },
      },
    }
  },
  STEER: ({ context }: { context: RootContext }) =>
    status !== "stopping" ? { context: changed(context) } : undefined,
  STOP: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.STOP.Type
  }) => {
    if (
      event.expectedRevision !== null &&
      context.revision !== event.expectedRevision
    )
      return
    const fresh =
      event.discoveryDeadline !== null && event.discoveryDeadline > event.now
    // Only the first Stop creates cancellation intent. Retrying it requires
    // the separate revisioned RETRY_STOP event and a fresh discovery lease.
    if (status === "stopping") return
    return {
      target: "stopping",
      context: {
        ...changed(context),
        control: {
          ...context.control,
          unconfirmed: fresh ? null : ("stop" as const),
          attempts: fresh
            ? context.control.owner === null
              ? 0
              : 1
            : (context.control.attempts ?? 0),
        },
        error: fresh ? null : event.error,
      },
    }
  },
  RETRY_STOP: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.RETRY_STOP.Type
  }) => {
    if (
      status !== "stopping" ||
      context.control.owner !== null ||
      context.control.unconfirmed === null ||
      context.revision !== event.expectedRevision ||
      event.discoveryDeadline <= event.now
    )
      return
    return {
      context: {
        ...changed(context),
        control: { ...context.control, unconfirmed: null, attempts: 0 },
        error: null,
      },
    }
  },
  EXHAUST: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.EXHAUST.Type
  }) => {
    if (
      context.control.owner !== null ||
      context.revision !== event.expectedRevision ||
      (status === "stopping" && event.phase !== "stop") ||
      !event.eligible
    )
      return
    return {
      context: {
        ...changed(context),
        control: {
          ...context.control,
          unconfirmed: status === "stopping" ? ("stop" as const) : event.phase,
        },
        error: event.error,
      },
    }
  },
  COMPLETE: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.COMPLETE.Type
  }) => {
    if (
      context.parent !== null ||
      context.revision !== event.expectedRevision ||
      context.control.owner !== event.owner ||
      (context.control.unconfirmed !== null && event.owner === null) ||
      new Set(event.memberIds).size !== event.memberIds.length ||
      new Set(event.outcomes.map((o) => o.id)).size !== event.outcomes.length ||
      event.memberIds.length !== event.outcomes.length ||
      !event.memberIds.includes(context.id) ||
      event.outcomes.some((o) => !event.memberIds.includes(o.id))
    )
      return
    const outcome = event.outcomes.find((o) => o.id === context.id)!
    return {
      target: finishStatus(true, status === "stopping", outcome.delivery),
      context: {
        ...context,
        answer: event.answer,
        error: status === "stopping" ? null : event.error,
      },
    }
  },
  FINISH_MEMBER: ({
    context,
    event,
  }: {
    context: RootContext
    event: typeof events.FINISH_MEMBER.Type
  }) =>
    context.parent !== null
      ? { target: finishStatus(false, event.stopped, event.delivery) }
      : undefined,
})

export const rootRunMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: { input: Context, context: Context, events },
}).createMachine({
  id: "conversation-root-run",
  version: "1",
  context: ({ input }) => input,
  initial: "queued",
  on: {
    RELEASE: ({ context, event }) => release(context, event),
  },
  states: {
    queued: {
      on: {
        ...pending("queued"),
        PREPARE: { target: "preparing" },
        SUBMITTED: { target: "running" },
        RESTORE: ({ context }) => restore(context, "observe"),
      },
    },
    preparing: {
      on: {
        ...pending("preparing"),
        SUBMITTED: { target: "running" },
        RESTORE: ({ context }) => restore(context, "observe"),
      },
    },
    running: {
      on: {
        ...pending("running"),
        RESTORE: ({ context }) => restore(context, "observe"),
      },
    },
    stopping: {
      on: {
        ...pending("stopping"),
        RESTORE: ({ context }) => restore(context, "stop"),
      },
    },
    done: {},
    failed: {},
    cancelled: {},
  },
})
function restore(context: RootContext, phase: "observe" | "stop") {
  if (context.control.owner === null) return
  return {
    context: {
      ...changed(context),
      control: {
        owner: null,
        deadline: null,
        attempts: context.control.attempts ?? 0,
        unconfirmed: context.control.unconfirmed ?? phase,
      },
    },
  }
}
export type RootRunEvent = EventFromLogic<typeof rootRunMachine>
const contextOf = (turn: Turn): RootContext =>
  Schema.decodeUnknownSync(Context)({
    id: turn.id,
    parent: turn.parent_id,
    revision: turn.revision,
    control: conversationControl(turn),
    answer: turn.answer,
    error: turn.error,
  })
function validateControl(control: ConversationControl) {
  if (
    (control.owner === null) !== (control.deadline === null) ||
    control.owner === "" ||
    (control.deadline !== null && !Number.isFinite(control.deadline))
  )
    throw new Error("Invalid persisted conversation control")
}
export function newRootRun(id: string, parent: string | null) {
  const [snapshot, effects] = initialTransition(rootRunMachine, {
    id,
    parent,
    revision: 0,
    control: emptyConversationControl(),
    answer: "",
    error: null,
  })
  if (effects.length)
    throw new Error("Unsupported conversation initialization effect")
  return { status: snapshot.value as Turn["status"], ...snapshot.context }
}
export function advanceRootRun(
  turn: Turn,
  event: RootRunEvent
): Turn | undefined {
  if (
    (turn.schemaVersion !== undefined && turn.schemaVersion !== 1) ||
    (turn.workflowVersion !== undefined && turn.workflowVersion !== 1)
  )
    throw new Error("Unsupported conversation version")
  const context = contextOf(turn)
  validateControl(context.control)
  if (!event || typeof event !== "object" || !Object.hasOwn(events, event.type))
    throw new Error("Unknown conversation event")
  const { type, ...payload } = event
  if (
    Object.keys(payload).some((key) => !Object.hasOwn(events[type].fields, key))
  )
    throw new Error("Unknown conversation event field")
  Schema.decodeUnknownSync(events[type], { onExcessProperty: "error" })(payload)
  const before = rootRunMachine.resolveState({ value: turn.status, context })
  const [next, effects] = transition(rootRunMachine, before, event)
  if (effects.length)
    throw new Error(
      `Unsupported durable conversation effect: ${effects[0]!.type}`
    )
  if (
    next.value === before.value &&
    JSON.stringify(next.context) === JSON.stringify(before.context)
  )
    return
  validateControl(next.context.control)
  return {
    ...turn,
    schemaVersion: 1,
    workflowVersion: 1,
    status: next.value as Turn["status"],
    revision: next.context.revision,
    control: next.context.control,
    answer: next.context.answer,
    error: next.context.error,
  }
}
export const ownsConversation = (root: Turn, owner?: string) =>
  conversationControl(root).owner === (owner ?? null)

/** One pure completion decision is shared by the store and the Memory journal. */
export function completionDecision(
  root: Turn,
  current: Turn,
  members: readonly Turn[],
  outcomes: readonly TurnOutcome[],
  answer: string,
  error: string | null,
  owner?: string
) {
  if (
    root.id !== current.id ||
    current.parent_id !== null ||
    members.some(
      (member) => member.id !== root.id && member.parent_id !== root.id
    )
  )
    return
  const next = advanceRootRun(current, {
    type: "COMPLETE",
    expectedRevision: root.revision,
    owner: owner ?? null,
    memberIds: members.map((member) => member.id),
    outcomes,
    answer,
    error,
  })
  if (!next) return
  const completed: Turn[] = []
  for (const member of members) {
    const outcome = outcomes.find((item) => item.id === member.id)!
    const receipt = advanceInput(member, {
      type: "FINISH",
      delivery: outcome.delivery,
    })
    if (!receipt) return
    const run =
      member.id === root.id
        ? next
        : advanceRootRun(member, {
            type: "FINISH_MEMBER",
            delivery: outcome.delivery,
            stopped: current.status === "stopping",
          })
    if (!run) return
    completed.push({
      ...receipt,
      status: run.status,
      control: run.control,
      revision: run.revision,
      answer: run.answer,
      error: run.error,
    })
  }
  return { members: completed, answer: next.answer, error: next.error }
}
