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

export function preparePlanRevision(
  previous: Plan | null,
  input: PlanUpdate,
  source: PlanSource,
  evidence: Evidence[],
  now: string
): Omit<Plan, "state" | "complete"> {
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
  const { complete: _, ...draft } = input.draft
  return {
    ...draft,
    steps,
    nextAction:
      input.draft.complete && steps.some((step) => step.status !== "completed")
        ? "Reassess reopened steps against current requirements and evidence."
        : input.draft.nextAction,
    id: input.id,
    schemaVersion: 1,
    revision: (previous?.revision ?? 0) + 1,
    rootTurns: [...new Set([...(previous?.rootTurns ?? []), source.turnId])],
    inputIds: [...new Set([...(previous?.inputIds ?? []), ...source.inputIds])],
    reviewedTurn: source.turnId,
    inputRevision: source.inputRevision,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
}
