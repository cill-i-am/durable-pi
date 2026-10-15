import {
  AccessConflict,
  AccessDenied,
  type AccessMode,
  type ToolPolicy,
} from "./contracts"
import type { DispatchDecision, ToolIntent, ToolOperation } from "./ledger"

export function requirePolicy(policy: ToolPolicy | undefined): ToolPolicy {
  if (!policy) throw new AccessDenied({ message: "This tool is unavailable." })
  return policy
}

export function revisePolicy(
  current: ToolPolicy,
  expected: number,
  mode: AccessMode
): ToolPolicy {
  if (
    current.mode === mode &&
    (current.revision === expected || current.revision === expected + 1)
  )
    return current
  if (current.revision !== expected)
    throw new AccessConflict({
      message: "Tool access changed. Reload before updating it.",
    })
  return { ...current, mode, revision: current.revision + 1 }
}

export function replayIntent(
  input: ToolIntent,
  existing: ToolOperation | undefined
) {
  if (
    existing &&
    (existing.turnId !== input.turnId ||
      existing.tool !== input.tool ||
      existing.input !== input.input)
  )
    throw new AccessConflict({
      message: "Tool operation identity does not match.",
    })
  return existing
}

export function admitOperation(
  input: ToolIntent,
  policy: ToolPolicy,
  pending: number,
  now: number
): ToolOperation {
  if (policy.mode === "deny")
    throw new AccessDenied({
      message: "This tool is denied by the bot's access policy.",
    })
  if (input.input.length > 64_000)
    throw new AccessDenied({
      message: "Tool arguments exceed the approval limit.",
    })
  if (pending >= 20)
    throw new AccessDenied({
      message: "Resolve the pending approvals before requesting more tools.",
    })
  return {
    ...input,
    createdAt: now,
    expiresAt: now + 15 * 60_000,
    status: policy.mode === "ask" ? "pending" : "approved",
    grantRevision: policy.revision,
    revision: 0,
    decision: null,
    result: null,
  }
}

export function decisionIdentity(
  approve: boolean,
  expectedRevision: number,
  remember?: { expectedPolicyRevision: number }
) {
  if (remember && !approve)
    throw new AccessConflict({
      message: "Only an approval can allow future calls.",
    })
  return JSON.stringify({
    approve,
    expectedRevision,
    policyRevision: remember?.expectedPolicyRevision ?? null,
  })
}

export function approvalRound(
  operation: ToolOperation | undefined,
  approve: boolean,
  expectedRevision: number,
  decision: string,
  remember?: { expectedPolicyRevision: number }
) {
  if (!operation)
    throw new AccessConflict({ message: "This approval no longer exists." })
  if (operation.decision === decision && operation.status !== "pending")
    return { operation, replay: true } as const
  if (
    !remember &&
    !operation.decision &&
    operation.status === (approve ? "approved" : "denied") &&
    operation.revision === expectedRevision + 1
  )
    return { operation, replay: true } as const
  if (operation.status !== "pending" || operation.revision !== expectedRevision)
    throw new AccessConflict({
      message: "This approval has already ended. Refresh the conversation.",
    })
  return { operation, replay: false } as const
}

export function decideOperation(
  operation: ToolOperation,
  current: ToolPolicy,
  approve: boolean,
  decision: string,
  remember?: { expectedPolicyRevision: number }
) {
  if (approve && current.mode === "deny")
    throw new AccessDenied({
      message: "This tool has been denied. Update its access policy first.",
    })
  if (remember && current.revision !== remember.expectedPolicyRevision)
    throw new AccessConflict({
      message: "Tool access changed. Reload before allowing future calls.",
    })
  const grantRevision =
    current.revision + (remember && current.mode !== "allow" ? 1 : 0)
  return {
    operation: {
      ...operation,
      status: approve ? ("approved" as const) : ("denied" as const),
      grantRevision,
      decision,
      revision: operation.revision + 1,
    },
    grant:
      remember && current.mode !== "allow"
        ? { mode: "allow" as const, revision: grantRevision }
        : undefined,
  }
}

export interface DispatchTransition {
  readonly decision: DispatchDecision | AccessDenied
  readonly update?: Pick<ToolOperation, "status" | "grantRevision">
}

/** Rejections with updates must commit their fence before being raised. */
export function requireOperation(
  operation: ToolOperation | undefined
): ToolOperation {
  if (!operation)
    throw new AccessDenied({ message: "This tool operation is unavailable." })
  return operation
}

export function claimOperation(
  operation: ToolOperation,
  policy: ToolPolicy,
  recoverable: boolean,
  now: number
): DispatchTransition {
  if (policy.mode === "deny")
    throw new AccessDenied({ message: "Tool access has been revoked." })
  if (operation.status === "done" && operation.result !== null)
    return { decision: { result: operation.result } }
  if (
    operation.status === "running" &&
    recoverable &&
    (operation.expiresAt <= now || operation.grantRevision !== policy.revision)
  ) {
    const expired = operation.expiresAt <= now
    return {
      update: {
        status: expired ? "expired" : "denied",
        grantRevision: operation.grantRevision,
      },
      decision: new AccessDenied({
        message: expired
          ? "This interrupted tool request has expired. Read current state before requesting a new change."
          : "Tool access changed after dispatch. Read current state before requesting a new change.",
      }),
    }
  }
  if (operation.status === "running" && !recoverable)
    return {
      update: { status: "interrupted", grantRevision: operation.grantRevision },
      decision: new AccessDenied({
        message:
          "This tool was interrupted after it started. Its outcome is unknown; check before retrying.",
      }),
    }
  if (
    !["pending", "approved"].includes(operation.status) &&
    !(recoverable && operation.status === "running")
  )
    throw new AccessDenied({
      message: `This tool request is ${operation.status}.`,
    })
  if (
    policy.mode === "ask" &&
    ((operation.status !== "approved" &&
      !(recoverable && operation.status === "running")) ||
      operation.grantRevision !== policy.revision)
  )
    return {
      decision: "pending",
      update:
        operation.status !== "pending" ||
        operation.grantRevision !== policy.revision
          ? { status: "pending", grantRevision: policy.revision }
          : undefined,
    }
  return {
    decision: "execute",
    update: { status: "running", grantRevision: policy.revision },
  }
}

export function validateResult(result: string) {
  if (result.length > 250_000)
    throw new AccessDenied({
      message: "Tool output exceeded its stored result limit.",
    })
}
