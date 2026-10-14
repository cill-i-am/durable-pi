import type { Approval } from "@/access/contracts"

export type ConfirmedDecision = {
  revision: number
  approve: boolean
  remember?: boolean
}
export function approvalDecision(
  approval: Approval,
  confirmed: ConfirmedDecision | null
) {
  if (confirmed && approval.revision <= confirmed.revision)
    return confirmed.approve
  if (approval.status === "approved") return true
  if (approval.status === "denied") return false
  return null
}
