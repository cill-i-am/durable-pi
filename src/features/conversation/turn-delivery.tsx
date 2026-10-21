import { useMemo } from "react"

import { Button } from "@/components/ui/button"
import { MessageFooter } from "@/components/ui/message"
import type { ChatState } from "@/conversations/contracts"

export function TurnDelivery({
  turn,
  waiting,
  onCancel,
}: {
  turn: ChatState["turns"][number]
  waiting: boolean
  onCancel: () => void
}) {
  const pending = turn.status === "queued"
  const timestamp = useMemo(
    () =>
      new Date(turn.created_at).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [turn.created_at]
  )
  return (
    <MessageFooter className={pending ? undefined : "message-timestamp"}>
      {turn.preparingFiles && pending
        ? "Preparing files…"
        : pending
          ? waiting
            ? "Queued"
            : "Starting…"
          : timestamp}
      {pending && (
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </MessageFooter>
  )
}
