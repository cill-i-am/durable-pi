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
import { TurnActivity, SteeringMessage } from "./turn-activity"

export function TurnReply({
  turn,
  toolTitles,
  agentName,
  agentId,
  onRetry,
  retrying,
  canRetry,
}: {
  turn: ChatState["turns"][number]
  toolTitles?: Record<string, string>
  agentName: string
  agentId?: string
  onRetry?: (id: string) => void
  retrying?: string | null
  canRetry?: boolean
}) {
  const stopped = turn.status === "cancelled"
  const failed = turn.status === "failed"
  return (
    <Message align="start">
      <MessageContent>
        <MessageHeader>
          <span className="assistant-label">{agentName}</span>
        </MessageHeader>
        {!!turn.skills?.length && (
          <p className="text-xs text-muted-foreground">
            Skills:{" "}
            {turn.skills
              .map((skill) => `${skill.name} v${skill.revision}`)
              .join(" · ")}
          </p>
        )}
        <Bubble variant="ghost">
          <BubbleContent className="message-text">
            {turn.activity?.length ? (
              <TurnActivity
                items={turn.activity}
                agentId={agentId}
                toolTitles={toolTitles}
              />
            ) : turn.answer ? (
              <Markdown text={turn.answer} />
            ) : ["running", "preparing", "stopping"].includes(turn.status) ? (
              <span className="shimmer text-muted-foreground">
                {turn.status === "stopping"
                  ? "Stopping…"
                  : turn.status === "preparing"
                    ? "Finding the thread…"
                    : "Thinking…"}
              </span>
            ) : null}
          </BubbleContent>
        </Bubble>
        {turn.steering
          ?.filter(
            (input) =>
              !turn.activity?.some((item) => item.id === `steer:${input.id}`)
          )
          .map((input) => (
            <SteeringMessage
              key={input.id}
              text={input.text}
              attachments={input.attachments}
              agentId={agentId}
              label={
                input.delivery === "unanswered"
                  ? "Not answered · saved"
                  : input.delivery === "answered"
                    ? "Steered this reply"
                    : "Waiting for the next tool boundary…"
              }
            />
          ))}
        {turn.steering
          ?.filter((input) => input.delivery === "unanswered")
          .map(
            (input) =>
              onRetry && (
                <Button
                  key={`retry:${input.id}`}
                  variant="ghost"
                  size="xs"
                  disabled={!!retrying || !canRetry}
                  aria-label={`Retry correction: ${input.text.slice(0, 80)}`}
                  onClick={() => onRetry(input.id)}
                >
                  {retrying === input.id ? "Retrying…" : "Retry correction"}
                </Button>
              )
          )}
        {(turn.answer || stopped || failed) && (
          <MessageFooter>
            {turn.answer && <CopyReply text={turn.answer} />}
            {stopped
              ? "Stopped. Your message is saved."
              : failed
                ? "Interrupted"
                : ""}
            {(stopped || failed) && onRetry && (
              <Button
                variant="ghost"
                size="xs"
                disabled={!!retrying || !canRetry}
                onClick={() => onRetry(turn.id)}
              >
                {retrying === turn.id ? "Retrying…" : "Retry message"}
              </Button>
            )}
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
