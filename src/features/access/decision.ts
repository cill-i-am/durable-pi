import { Schema, type Cause } from "effect"

import type { Approval, ToolPolicy } from "@/access/contracts"

export type ConfirmedDecision = {
  approval: Approval
  revision: number
  approve: boolean
  remember?: boolean
  policy?: ToolPolicy | null
}
/** An older acknowledgement can confirm its action without superseding a
 * newer observed policy. Equal revisions must agree on the permission. */
export function futurePermissionCurrent(
  confirmed: ConfirmedDecision | null,
  policy: ToolPolicy | null
) {
  return !!(
    confirmed?.remember &&
    confirmed.policy?.mode === "allow" &&
    policy?.name === confirmed.approval.tool &&
    policy.name === confirmed.policy.name &&
    (policy.revision < confirmed.policy.revision ||
      (policy.revision === confirmed.policy.revision &&
        policy.mode === "allow"))
  )
}
export function sameApproval(a: Approval, b: Approval) {
  return (
    a.id === b.id &&
    a.turnId === b.turnId &&
    a.tool === b.tool &&
    a.input === b.input &&
    a.createdAt === b.createdAt &&
    a.expiresAt === b.expiresAt
  )
}
export function approvalDecision(
  approval: Approval,
  confirmed: ConfirmedDecision | null
) {
  if (
    confirmed &&
    sameApproval(approval, confirmed.approval) &&
    approval.revision <= confirmed.revision
  )
    return confirmed.approve
  if (approval.status === "approved") return true
  if (approval.status === "denied") return false
  return null
}

const hasMessage = Schema.is(Schema.Struct({ message: Schema.String }))
export function accessFailureMessage(
  cause: Cause.Cause<unknown>,
  fallback: string
) {
  const failure = cause.reasons.find((reason) => reason._tag === "Fail")
  return failure?._tag === "Fail" && hasMessage(failure.error)
    ? `${failure.error.message} ${fallback}`
    : fallback
}
