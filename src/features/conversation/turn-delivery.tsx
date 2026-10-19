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
  return (
    <MessageFooter className={pending ? undefined : "message-timestamp"}>
      {turn.preparingFiles && pending
        ? "Preparing files…"
        : pending
          ? waiting
            ? "Queued"
            : "Starting…"
          : new Date(turn.created_at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
      {pending && (
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </MessageFooter>
  )
}
