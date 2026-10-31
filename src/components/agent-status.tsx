import { Badge } from "@workspace/ui/components/badge"
import {
  CircleCheck,
  CircleDashed,
  ShieldQuestionMark,
  Square,
  CircleX,
  Pause,
  Archive,
  CircleHelp,
} from "lucide-react"

import type { RuntimeStatus } from "@/conversations/status"

const states = {
  ready: { label: "Ready", icon: CircleCheck },
  working: { label: "Working", icon: CircleDashed },
  "needs-approval": { label: "Needs approval", icon: ShieldQuestionMark },
  stopping: { label: "Stopping", icon: Square },
  blocked: { label: "Blocked", icon: Pause },
  failed: { label: "Failed", icon: CircleX },
  archived: { label: "Archived", icon: Archive },
  unavailable: { label: "Unavailable", icon: CircleHelp },
} satisfies Record<
  RuntimeStatus["state"],
  { label: string; icon: typeof CircleCheck }
>

export function agentStatusLabel(status: RuntimeStatus["state"] | undefined) {
  return states[status ?? "unavailable"].label
}

export function AgentStatus({
  status,
}: {
  status: RuntimeStatus["state"] | undefined
}) {
  const state = status ?? "unavailable"
  const { label, icon: Icon } = states[state]
  return (
    <Badge
      variant={
        state === "failed" || state === "blocked" ? "destructive" : "secondary"
      }
      data-agent-status={state}
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      {label}
    </Badge>
  )
}

export function AgentStatusMarker({
  status,
}: {
  status: RuntimeStatus["state"] | undefined
}) {
  const state = status ?? "unavailable"
  if (state === "ready") return null
  const Icon = states[state].icon
  return (
    <span
      className="agent-status-marker"
      data-agent-status={state}
      aria-hidden="true"
    >
      <Icon className="size-full" />
    </span>
  )
}
