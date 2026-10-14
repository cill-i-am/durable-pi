import { Schema } from "effect"
import type { ChatTurn } from "./contracts"
import type { RecoveryView } from "./recovery"

export const RuntimeStatus = Schema.Struct({
  state: Schema.Literals([
    "ready",
    "working",
    "needs-approval",
    "stopping",
    "blocked",
    "failed",
    "archived",
    "unavailable",
  ]),
  turnId: Schema.NullOr(Schema.String),
})
export type RuntimeStatus = typeof RuntimeStatus.Type
export type StatusTurn = Pick<ChatTurn, "id" | "status"> & {
  recovery?: Pick<RecoveryView, "phase"> | null
}

export function runtimeStatus(facts: {
  archived: boolean
  active?: StatusTurn
  latest?: StatusTurn
  needsApproval: boolean
  planBlocked: boolean
}): RuntimeStatus {
  const turn = facts.active ?? facts.latest
  const result = (state: RuntimeStatus["state"]): RuntimeStatus => ({
    state,
    turnId: turn?.id ?? null,
  })
  if (facts.archived) return result("archived")
  if (facts.active?.status === "stopping") return result("stopping")
  if (facts.active?.recovery?.phase === "blocked") return result("blocked")
  if (facts.active)
    return result(facts.needsApproval ? "needs-approval" : "working")
  if (turn?.status === "cancelled") return result("ready")
  if (turn?.recovery?.phase === "blocked") return result("blocked")
  if (turn?.status === "failed") return result("failed")
  if (facts.planBlocked) return result("blocked")
  return result("ready")
}
