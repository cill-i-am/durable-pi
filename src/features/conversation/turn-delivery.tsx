import { Button } from "@workspace/ui/components/button"

import { MessageFooter } from "@/components/ui/message"
import type { ChatState } from "@/conversations/contracts"

import { MessageTimestamp } from "./message-timestamp"

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
      <MessageTimestamp at={turn.created_at} />
      {pending && <span aria-hidden="true"> · </span>}
      {turn.preparingFiles && pending
        ? "Preparing files…"
        : pending
          ? waiting
            ? "Queued"
            : "Starting…"
          : null}
      {pending && (
        <Button variant="ghost" size="xs" onClick={onCancel}>
          Cancel
        </Button>
      )}
    </MessageFooter>
  )
}
