import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"

import type { Group } from "@/delegation/contracts"

import { useTaskControl } from "./use-task-control"

export function BackgroundActions({
  agentId,
  group,
}: {
  agentId: string
  group: Group
}) {
  const stop =
    !!group.background &&
    (group.background.stop === "pending" ||
      group.background.stop === "unconfirmed" ||
      !["delivered", "cancelled"].includes(group.background.delivery))
  const retry = group.background?.delivery === "paused"
  const controls = useTaskControl({
    agentId,
    groupId: group.id,
    childId: null,
    prefix: "background",
    active: [
      ...(stop ? ["stop" as const] : []),
      ...(retry ? ["retry" as const] : []),
    ],
  })
  return (
    <div className="mt-3 flex flex-col gap-2">
      {group.background?.error && (
        <Alert>
          <AlertDescription>{group.background.error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {(["stop", "retry"] as const).map((action) => {
          const active = action === "stop" ? stop : retry
          const saved = controls.saved(action)
          if (!active && !saved) return null
          return (
            <div key={action} className="flex min-w-0 flex-col gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={controls.blocked(action)}
                onClick={() => controls.submit(action)}
              >
                {controls.sending
                  ? "Sending…"
                  : action === "retry"
                    ? "Retry connection"
                    : saved ||
                        group.background?.stop === "pending" ||
                        group.background?.stop === "unconfirmed"
                      ? "Retry stop"
                      : "Stop group"}
              </Button>
              {saved && (
                <p className="text-xs text-muted-foreground">
                  Saved action awaiting acknowledgement. Retry uses the same
                  operation.
                </p>
              )}
            </div>
          )
        })}
      </div>
      {controls.error && (
        <Alert>
          <AlertDescription>{controls.error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
