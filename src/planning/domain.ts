import {
  PlanFailure,
  type Plan,
  type PlanUpdate,
  type Evidence,
} from "./contracts"
import type { PlanBinding } from "./ledger"
import type { PlanSource } from "./plans"

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
    | "queued"
    | "accepted"
    | "consumed"
    | "answered"
    | "unanswered"
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
