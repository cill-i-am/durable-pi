import { useState } from "react"
import { Check, Copy } from "lucide-react"
import type { ChatState } from "@/conversations/contracts"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "@/components/ui/message"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { TurnActivity } from "./turn-activity"

export function TurnReply({
  turn,
  agentName,
}: {
  turn: ChatState["turns"][number]
  agentName: string
}) {
  const stopped = turn.status === "cancelled"
  const failed = turn.status === "failed"
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>
          <span className="assistant-label">{agentName}</span>
        </MessageHeader>
        <Bubble variant="ghost">
          <BubbleContent className="message-text">
            {turn.activity?.length ? (
              <TurnActivity items={turn.activity} />
            ) : turn.answer ? (
              <Markdown text={turn.answer} />
            ) : ["running", "preparing"].includes(turn.status) ? (
              <span className="shimmer text-muted-foreground">
                {turn.status === "preparing"
                  ? "Finding the thread…"
                  : "Thinking…"}
              </span>
            ) : null}
          </BubbleContent>
        </Bubble>
        {(turn.answer || stopped || failed) && (
          <MessageFooter>
            {turn.answer && <CopyReply text={turn.answer} />}
            {stopped
              ? "Stopped. Your message is saved."
              : failed
                ? "Interrupted"
                : ""}
          </MessageFooter>
        )}
        {turn.error && (
          <Alert role="alert">
            <AlertDescription>{turn.error}</AlertDescription>
          </Alert>
        )}
      </MessageContent>
    </Message>
  )
}
function CopyReply({ text }: { text: string }) {
  const [status, setStatus] = useState<"ready" | "copied" | "failed">("ready")
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      aria-label={
        status === "copied"
          ? "Copied"
          : status === "failed"
            ? "Copy failed. Try again"
            : "Copy response"
      }
      onClick={() =>
        void navigator.clipboard.writeText(text).then(
          () => setStatus("copied"),
          () => setStatus("failed")
        )
      }
    >
      {status === "copied" ? <Check /> : <Copy />}
    </Button>
  )
}
