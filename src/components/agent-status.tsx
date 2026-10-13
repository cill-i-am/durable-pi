import {
  CircleCheck,
  LoaderCircle,
  ShieldQuestionMark,
  Square,
  CircleAlert,
  OctagonAlert,
  Archive,
  CircleHelp,
} from "lucide-react"
import type { RuntimeStatus } from "@/conversations/status"
import { Badge } from "@/components/ui/badge"

const states = {
  ready: { label: "Ready", icon: CircleCheck },
  working: { label: "Working", icon: LoaderCircle },
  "needs-approval": { label: "Needs approval", icon: ShieldQuestionMark },
  stopping: { label: "Stopping", icon: Square },
  blocked: { label: "Blocked", icon: OctagonAlert },
  failed: { label: "Failed", icon: CircleAlert },
  archived: { label: "Archived", icon: Archive },
  unavailable: { label: "Unavailable", icon: CircleHelp },
} satisfies Record<
  RuntimeStatus["state"],
  { label: string; icon: typeof CircleCheck }
>

export function AgentStatus({
  status,
  compact = false,
}: {
  status: RuntimeStatus["state"] | undefined
  compact?: boolean
}) {
  const state = status ?? "unavailable"
  const { label, icon: Icon } = states[state]
  return (
    <Badge
      variant={
        state === "failed" || state === "blocked"
          ? "destructive"
          : compact
            ? "ghost"
            : "secondary"
      }
      data-agent-status={state}
      className={compact ? "agent-status-compact" : undefined}
    >
      <Icon data-icon="inline-start" aria-hidden="true" />
      {label}
    </Badge>
  )
}
