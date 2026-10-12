import type { Approval } from "@/access/contracts"

export type ConfirmedDecision = {
  revision: number
  approve: boolean
  remember?: boolean
}
/** Old snapshots may lag a confirmed decision; a newer approval round takes precedence. */
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
