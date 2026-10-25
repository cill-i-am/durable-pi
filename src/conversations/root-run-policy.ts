import {
  conversationControlAttemptLimit,
  type ConversationControl,
  type TurnOutcome,
} from "./turns"

type Root = {
  parent: string | null
  revision: number
  control: ConversationControl
}
type PendingStatus = "queued" | "preparing" | "running" | "stopping"

export function canClaimRoot(
  root: Root,
  status: PendingStatus,
  claim: {
    owner: string
    deadline: number
    now: number
    mode: "automatic" | "inspect" | "stop"
    expectedRevision: number | null
  }
) {
  if (root.parent !== null || root.control.owner !== null) return false
  if (!claim.owner || claim.deadline <= claim.now) return false
  if (
    claim.expectedRevision !== null &&
    root.revision !== claim.expectedRevision
  )
    return false
  if (claim.mode === "inspect") return true
  if ((root.control.attempts ?? 0) >= conversationControlAttemptLimit)
    return false
  return claim.mode === "stop"
    ? status === "stopping"
    : root.control.unconfirmed === null
}

export function canRetryRootStop(
  root: Root,
  status: PendingStatus,
  retry: { expectedRevision: number; discoveryDeadline: number; now: number }
) {
  return (
    status === "stopping" &&
    root.control.owner === null &&
    root.control.unconfirmed !== null &&
    root.revision === retry.expectedRevision &&
    !(retry.discoveryDeadline <= retry.now)
  )
}

export function canExhaustRoot(
  root: Root,
  status: PendingStatus,
  exhaustion: {
    expectedRevision: number
    phase: "handoff" | "observe" | "stop"
    eligible: boolean
  }
) {
  return (
    root.control.owner === null &&
    root.revision === exhaustion.expectedRevision &&
    (status !== "stopping" || exhaustion.phase === "stop") &&
    exhaustion.eligible
  )
}

/** A completion must account for the root and every member exactly once. */
export function completedRootOutcome(
  root: Root & { id: string },
  completion: {
    expectedRevision: number
    owner: string | null
    memberIds: readonly string[]
    outcomes: readonly Pick<TurnOutcome, "id" | "delivery">[]
  }
) {
  if (
    root.parent !== null ||
    root.revision !== completion.expectedRevision ||
    root.control.owner !== completion.owner ||
    (root.control.unconfirmed !== null && completion.owner === null)
  )
    return
  const members = new Set(completion.memberIds)
  const outcomes = new Map(
    completion.outcomes.map((outcome) => [outcome.id, outcome])
  )
  if (
    members.size !== completion.memberIds.length ||
    outcomes.size !== completion.outcomes.length ||
    members.size !== outcomes.size ||
    !members.has(root.id) ||
    completion.outcomes.some((outcome) => !members.has(outcome.id))
  )
    return
  return outcomes.get(root.id)
}
