import {
  PlanFailure,
  type Evidence,
  type Plan,
  type PlanUpdate,
} from "./contracts"
import type { PlanSource } from "./plans"

function requirePlanRevision(previous: Plan | null, input: PlanUpdate) {
  if (
    (previous?.revision ?? 0) !== input.expectedRevision ||
    (!previous && input.relation !== "new") ||
    (previous && input.relation === "new")
  )
    throw new PlanFailure({
      code: "conflict",
      message:
        "Read the current plan and reconcile its revision before updating.",
    })
}

export function revisePlan(
  previous: Plan | null,
  input: PlanUpdate,
  source: PlanSource,
  evidence: Evidence[],
  now: string
): Plan {
  if (previous?.state === "cancelled")
    throw new PlanFailure({
      code: "cancelled",
      message:
        "This task was cancelled. Only a new user request can start a new task.",
    })
  requirePlanRevision(previous, input)
  const requirementsChanged =
    !!previous &&
    (previous.objective !== input.draft.objective ||
      JSON.stringify(previous.constraints) !==
        JSON.stringify(input.draft.constraints) ||
      JSON.stringify(previous.criteria) !==
        JSON.stringify(input.draft.criteria))
  let offset = 0
  const steps = input.draft.steps.map((step) => {
    const refs = evidence.slice(offset, (offset += step.evidence.length))
    const old = previous?.steps.find((value) => value.id === step.id)
    const reopen =
      refs.some((ref) => ref.state === "invalid") ||
      (old?.status === "completed" &&
        (requirementsChanged || old.title !== step.title))
    return {
      ...step,
      evidence: refs,
      status:
        reopen && step.status === "completed"
          ? ("pending" as const)
          : step.status,
    }
  })
  const complete =
    input.draft.complete && steps.every((step) => step.status === "completed")
  return {
    ...input.draft,
    steps,
    complete,
    nextAction:
      input.draft.complete && !complete
        ? "Reassess reopened steps against current requirements and evidence."
        : input.draft.nextAction,
    id: input.id,
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    state: complete ? "completed" : "open",
    rootTurns: [...new Set([...(previous?.rootTurns ?? []), source.turnId])],
    inputIds: [...new Set([...(previous?.inputIds ?? []), ...source.inputIds])],
    reviewedTurn: source.turnId,
    inputRevision: source.inputRevision,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}
