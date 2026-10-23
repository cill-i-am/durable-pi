import { setupEffect } from "@xstate/effect"
import { Schema } from "effect"
import { initialTransition, transition } from "xstate"
import { standardSchemaValidator } from "xstate/validation"

import { Evidence, Plan, PlanFailure, PlanUpdate } from "./contracts"
import { preparePlanRevision } from "./plan"
import type { PlanSource } from "./plans"

const Source = Schema.Struct({
  turnId: Plan.fields.reviewedTurn,
  inputRevision: Plan.fields.inputRevision,
  inputIds: Plan.fields.inputIds,
})
const Context = Schema.Struct({ plan: Schema.NullOr(Plan) })
type RevisionEvent = {
  input: PlanUpdate
  source: typeof Source.Type
  evidence: readonly Evidence[]
  now: string
}
const revise = (saved: Plan | null, event: RevisionEvent) => {
  const prepared = preparePlanRevision(
    saved,
    event.input,
    { ...event.source, inputIds: [...event.source.inputIds] },
    [...event.evidence],
    event.now
  )
  const completed =
    event.input.draft.complete &&
    prepared.steps.every((step) => step.status === "completed")
  return {
    target: completed ? "completed" : "open",
    context: {
      plan: {
        ...prepared,
        complete: completed,
        state: completed ? ("completed" as const) : ("open" as const),
      },
    },
  }
}
const revalidate = (
  saved: Plan,
  event: {
    evidence: readonly (readonly Evidence[])[]
    cancelled: boolean
    now: string
  }
) => {
  if (event.evidence.length !== saved.steps.length)
    throw new Error("Plan evidence does not match its saved steps")
  const steps = saved.steps.map((step, index) => ({
    ...step,
    evidence: event.evidence[index]!,
    status:
      event.evidence[index]!.some((ref) => ref.state === "invalid") &&
      step.status === "completed"
        ? ("pending" as const)
        : step.status,
  }))
  if (!event.cancelled && JSON.stringify(steps) === JSON.stringify(saved.steps))
    return
  const reopened = steps.some(
    (step, index) => step.status !== saved.steps[index]!.status
  )
  const state = event.cancelled ? "cancelled" : reopened ? "open" : saved.state
  return {
    target: state,
    context: {
      plan: {
        ...saved,
        steps,
        state,
        complete: state === "completed",
        revision: saved.revision + 1,
        updatedAt: event.now,
        nextAction: event.cancelled
          ? ""
          : reopened
            ? "Reassess the reopened steps; their evidence is no longer current."
            : saved.nextAction,
        blocker: event.cancelled
          ? "Stopped by the user or run lifecycle."
          : saved.blocker,
      },
    },
  }
}
export const planMachine = setupEffect({
  validator: standardSchemaValidator(),
  schemas: {
    input: Context,
    context: Context,
    events: {
      REVISE: Schema.Struct({
        input: PlanUpdate,
        source: Source,
        evidence: Schema.Array(Evidence),
        now: Schema.String,
      }),
      REVALIDATE: Schema.Struct({
        evidence: Schema.Array(Schema.Array(Evidence)),
        cancelled: Schema.Boolean,
        now: Schema.String,
      }),
    },
  },
}).createMachine({
  id: "plan",
  version: "1",
  context: ({ input }) => input,
  initial: "empty",
  states: {
    empty: { on: { REVISE: ({ event }) => revise(null, event) } },
    open: {
      on: {
        REVISE: ({ context, event }) => revise(context.plan, event),
        REVALIDATE: ({ context, event }) => revalidate(context.plan!, event),
      },
    },
    completed: {
      on: {
        REVISE: ({ context, event }) => revise(context.plan, event),
        REVALIDATE: ({ context, event }) => revalidate(context.plan!, event),
      },
    },
    cancelled: {
      on: {
        REVISE: () => {
          throw new PlanFailure({
            code: "cancelled",
            message:
              "This task was cancelled. Only a new user request can start a new task.",
          })
        },
        REVALIDATE: {},
      },
    },
  },
})
const PersistedPlan = Plan.check(
  Schema.makeFilter(
    (plan) =>
      plan.complete === (plan.state === "completed") &&
      (!plan.complete ||
        plan.steps.every((step) => step.status === "completed"))
  )
)
export function restorePlan(raw: unknown): Plan {
  return Schema.decodeUnknownSync(PersistedPlan)(raw)
}
function advancePlan(
  raw: Plan | null,
  event:
    | ({ type: "REVISE" } & RevisionEvent)
    | {
        type: "REVALIDATE"
        evidence: readonly (readonly Evidence[])[]
        cancelled: boolean
        now: string
      }
) {
  const plan = raw ? restorePlan(raw) : null
  const [fresh, initial] = initialTransition(planMachine, { plan })
  if (initial.length) throw new Error("Plan initialization cannot run effects")
  const saved = plan
    ? planMachine.resolveState({ value: plan.state, context: { plan } })
    : fresh
  const [next, effects] = transition(planMachine, saved, event)
  if (effects.length) throw new Error("Plan transitions cannot run effects")
  return restorePlan(next.context.plan)
}
export const revisePlan = (
  previous: Plan | null,
  input: PlanUpdate,
  source: PlanSource,
  evidence: Evidence[],
  now: string
) => advancePlan(previous, { type: "REVISE", input, source, evidence, now })
export function reconcilePlan(
  saved: Plan,
  evidence: readonly (readonly Evidence[])[],
  cancelled: boolean,
  now: string
): Plan | null {
  const next = advancePlan(saved, {
    type: "REVALIDATE",
    evidence,
    cancelled,
    now,
  })
  return next.revision === saved.revision ? null : next
}
