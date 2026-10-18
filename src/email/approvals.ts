import {
  builtInTools,
  type Approval,
  type ToolPolicy,
} from "../access/contracts"

export interface EmailApprovalProofs {
  sign: (recipient: string, approval: Approval) => string
  verify: (
    recipient: string,
    token: string,
    now: number
  ) => { id: string; turnId: string; revision: number; expiresAt: number }
}

/** Only an explicit first line is a command. Quoted requests never decide. */
export function emailDecision(body: string) {
  const first = body.trimStart().split(/\r?\n/, 1)[0]!.trim()
  const command = /^(APPROVE|DENY)(?:\s+(.*))?$/i.exec(first)
  return command
    ? {
        approve: command[1]!.toUpperCase() === "APPROVE",
        token: command[2] ?? "",
      }
    : undefined
}
const label = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (first) => first.toUpperCase())
function readable(value: unknown, indent = ""): string {
  if (Array.isArray(value))
    return value
      .map((item) => `${indent}• ${readable(item, indent + "  ")}`)
      .join("\n")
  if (value !== null && typeof value === "object")
    return Object.entries(value)
      .map(([key, item]) =>
        typeof item === "number" && key.endsWith("Ms")
          ? `${indent}${label(key.slice(0, -2))}: ${item / 1000} seconds`
          : `${indent}${label(key)}: ${readable(item, indent + "  ")}`
      )
      .join("\n")
  return String(value)
}
export function approvalDetails(input: string) {
  try {
    return readable(JSON.parse(input))
  } catch {
    return input
  }
}
export function emailApprovalNotice(
  approval: Approval,
  token: string,
  policy?: ToolPolicy
) {
  const tool = builtInTools.find((tool) => tool.name === approval.tool)
  const title =
    policy?.title ??
    (tool && "title" in tool ? tool.title : label(approval.tool))
  return `An action needs your approval.\n\n${title}\n\n${approvalDetails(approval.input)}\n\nExpires: ${new Date(approval.expiresAt).toUTCString()}\n\nTo allow this call once, reply with this as the first line:\nAPPROVE ${token}\n\nTo deny it, reply with this as the first line:\nDENY ${token}\n\nThis decision applies only to the action shown above. Keep this email private.`
}
