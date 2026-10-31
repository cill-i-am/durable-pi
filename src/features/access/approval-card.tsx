import { Check, CircleAlert, Clock3, X } from "lucide-react"

import type { Approval, ToolPolicy } from "@/access/contracts"

import { formatApprovalInput } from "./decision"

import "./decision-dock.css"

/** A transcript receipt has no command owner. Pending requests live in the dock. */
export function ApprovalCard({
  approval,
  toolLabel,
}: {
  approval: Approval
  agentId: string
  disabled: boolean
  toolLabel?: string
  toolPolicy?: ToolPolicy
  agentName?: string
}) {
  const status = {
    pending: "Awaiting approval",
    approved: "Approval accepted · waiting to run",
    running: "Approved · running",
    done: "Action completed",
    denied: "Declined",
    cancelled: "Cancelled",
    expired: "Approval expired",
    interrupted: "Interrupted · outcome needs checking",
  }[approval.status]
  const Icon =
    approval.status === "done"
      ? Check
      : approval.status === "interrupted"
        ? CircleAlert
        : approval.status === "denied" || approval.status === "cancelled"
          ? X
          : Clock3
  return (
    <div
      className="approval-receipt"
      role="region"
      aria-label={`Approval for ${toolLabel ?? approval.tool}`}
      data-status={approval.status}
    >
      <Icon aria-hidden="true" />
      <div>
        <p>
          <strong>{toolLabel ?? approval.tool}</strong> · {status}
        </p>
        {approval.status === "interrupted" && (
          <p>Check the outcome before trying again.</p>
        )}
        <details>
          <summary>Action inputs</summary>
          <pre>{formatApprovalInput(approval.input)}</pre>
        </details>
      </div>
    </div>
  )
}
