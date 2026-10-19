import { ActivityOrb } from "@/components/activity-visuals"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { CopyButton } from "@/components/copy-button"
import { Markdown } from "@/components/markdown"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import {
  Message,
  MessageContent,
  MessageHeader,
  MessageFooter,
} from "@/components/ui/message"
import type { ChatState } from "@/conversations/contracts"
import { FileAttachments } from "@/features/files/file-attachments"

import { TurnActivity, SteeringMessage } from "./turn-activity"

export function TurnReply({
  turn,
  toolTitles,
  agentName,
  agentId,
  onRetry,
  retrying,
  canRetry,
  onAppPendingChange,
  waitingForApproval,
  onAnswerPrompt,
}: {
  turn: ChatState["turns"][number]
  toolTitles?: Record<string, string>
  agentName: string
  agentId?: string
  onRetry?: (id: string) => void
  retrying?: string | null
  canRetry?: boolean
  onAppPendingChange?: (key: string, pending: boolean) => void
  waitingForApproval?: boolean
  onAnswerPrompt?: (text: string) => void
}) {
  const stopped = turn.status === "cancelled"
  const failed = turn.status === "failed"
  return (
    <Message align="start" className="assistant-message">
      <MessageContent>
        <MessageHeader className="sr-only">
          <AgentMark tone={agentId ? agentTone(agentId) : "primary"} />
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
        <ReplyBody
          onAnswerPrompt={onAnswerPrompt}
          turn={turn}
          agentId={agentId}
          toolTitles={toolTitles}
          onAppPendingChange={onAppPendingChange}
          waitingForApproval={waitingForApproval}
        />
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
              provenance={input.provenance}
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
            {turn.answer && (
              <CopyButton text={turn.answer} label="Copy response" />
            )}
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

function ReplyBody({
  onAnswerPrompt,
  turn,
  agentId,
  toolTitles,
  onAppPendingChange,
  waitingForApproval,
}: Pick<
  Parameters<typeof TurnReply>[0],
  | "turn"
  | "agentId"
  | "toolTitles"
  | "onAppPendingChange"
  | "onAnswerPrompt"
  | "waitingForApproval"
>) {
  return (
    <Bubble variant="ghost">
      <BubbleContent className="message-text">
        {turn.activity?.length ? (
          <TurnActivity
            onAnswerPrompt={onAnswerPrompt}
            onAppPendingChange={onAppPendingChange}
            items={turn.activity}
            agentId={agentId}
            toolTitles={toolTitles}
            status={turn.status}
            waitingForApproval={waitingForApproval}
          />
        ) : turn.answer ? (
          <Markdown text={turn.answer} />
        ) : ["queued", "running", "preparing", "stopping"].includes(
            turn.status
          ) ? (
          <span className="working-indicator" role="status">
            <ActivityOrb
              state={turn.status === "preparing" ? "searching" : "breathing"}
              active={turn.status !== "stopping"}
            />
            {turn.status === "stopping"
              ? "Stopping…"
              : turn.status === "queued"
                ? "Starting…"
                : turn.status === "preparing"
                  ? "Finding the thread…"
                  : "Thinking…"}
          </span>
        ) : null}
        {agentId && !!turn.replyFiles?.length && (
          <FileAttachments files={turn.replyFiles} agentId={agentId} />
        )}
      </BubbleContent>
    </Bubble>
  )
}
