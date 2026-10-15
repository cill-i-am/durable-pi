import {
  PlanFailure,
  type Plan,
  type PlanUpdate,
  type Evidence,
} from "./contracts"
import type { PlanSource } from "./plans"
import type { PlanBinding, PlanOperation } from "./ledger"

export function requirePlanWritable(
  current: PlanSource | undefined,
  source: PlanSource,
  replay = false
) {
  if (!current)
    throw new PlanFailure({
      code: "cancelled",
      message: "This run has stopped. A saved plan cannot resume it.",
    })
  if (
    !replay &&
    (current.pendingInputs ||
      current.inputRevision !== source.inputRevision ||
      JSON.stringify(current.inputIds) !== JSON.stringify(source.inputIds))
  )
    throw new PlanFailure({
      code: "conflict",
      message:
        "New user input arrived. Read the current input revision and revise the plan before continuing.",
    })
}
export function requirePlanInputRevision(
  input: PlanUpdate,
  source: PlanSource
) {
  if (source.inputRevision !== input.inputRevision)
    throw new PlanFailure({
      code: "conflict",
      message: "Read the current input revision before updating this plan.",
    })
}
export function requirePlanBinding(binding: PlanBinding, id: string) {
  if (binding.cancelled)
    throw new PlanFailure({
      code: "cancelled",
      message: "This run was cancelled.",
    })
  if (binding.planId && binding.planId !== id)
    throw new PlanFailure({
      code: "conflict",
      message: "This run already belongs to a different logical task.",
    })
}
export function planReplay(operation: PlanOperation, digest: string) {
  if (!operation.receipt) return undefined
  if (operation.digest !== digest)
    throw new PlanFailure({
      code: "conflict",
      message: "This tool operation belongs to another update.",
    })
  return { ...operation.receipt, reopened: [...operation.receipt.reopened] }
}
export function requirePlanCapacity(previous: Plan | null, count: number) {
  if (
    (!previous && count >= 200) ||
    (previous &&
      (previous.revision >= 1000 || previous.rootTurns.length >= 100))
  )
    throw new PlanFailure({
      code: "limit",
      message:
        "This task has reached its plan history limit. Start a new task when the user requests new work.",
    })
}
export function requireUncancelledPlan(cancelled: boolean) {
  if (cancelled)
    throw new PlanFailure({
      code: "cancelled",
      message: "This task was cancelled. Do not resume it from its saved plan.",
    })
}
export function requirePlanEvidence(evidence: readonly Evidence[]) {
  if (evidence.some((ref) => ref.state !== "valid"))
    throw new PlanFailure({
      code: "invalid",
      message:
        "An evidence reference is unavailable, stale or unsuccessful. Inspect the source before revising the plan.",
    })
}
export function reconcilePlan(
  saved: Plan,
  evidence: readonly (readonly Evidence[])[],
  cancelled: boolean,
  now: string
): Plan | null {
  const steps = saved.steps.map((step, index) => ({
    ...step,
    evidence: evidence[index]!,
    status:
      evidence[index]!.some((ref) => ref.state === "invalid") &&
      step.status === "completed"
        ? ("pending" as const)
        : step.status,
  }))
  if (!cancelled && JSON.stringify(steps) === JSON.stringify(saved.steps))
    return null
  const reopened = steps.some(
    (step, index) => step.status !== saved.steps[index]!.status
  )
  return {
    ...saved,
    steps,
    revision: saved.revision + 1,
    updatedAt: now,
    state: cancelled ? "cancelled" : reopened ? "open" : saved.state,
    complete: cancelled || reopened ? false : saved.complete,
    nextAction: cancelled
      ? ""
      : reopened
        ? "Reassess the reopened steps; their evidence is no longer current."
        : saved.nextAction,
    blocker: cancelled
      ? "Stopped by the user or run lifecycle."
      : saved.blocker,
  }
}
export const planHistoryKey = (id: string, revision: number) =>
  `${id}:${revision}`
export const isPlanBlocked = (
  binding: PlanBinding | undefined,
  plan: Plan | null,
  turn: string
) =>
  !!binding?.planId &&
  !binding.cancelled &&
  !!plan &&
  plan.rootTurns.includes(turn) &&
  plan.state === "open" &&
  !!plan.blocker.trim()

export interface PlanningInput {
  readonly id: string
  readonly steering: boolean
  readonly text: string
  readonly hasAttachments: boolean
  readonly delivery:
    "queued" | "accepted" | "consumed" | "answered" | "unanswered"
}
export function planningInputSource(
  turnId: string,
  inputRevision: number,
  inputs: readonly PlanningInput[]
): PlanSource {
  return {
    turnId,
    inputRevision,
    inputIds: inputs.map((input) => input.id),
    pendingInputs: inputs.some(
      (input) =>
        input.steering &&
        (input.delivery === "queued" ||
          (input.hasAttachments &&
            input.delivery !== "consumed" &&
            input.delivery !== "answered"))
    ),
    steering: inputs
      .filter((input) => input.steering)
      .map((input) => ({
        id: input.id,
        text: input.text || "Please inspect the attached files.",
        hasAttachments: input.hasAttachments,
        nativeDelivered:
          input.delivery === "consumed" || input.delivery === "answered",
      })),
  }
}
