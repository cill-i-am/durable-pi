import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  LoaderCircle,
  Wrench,
} from "lucide-react"
import { Fragment } from "react"
import { InlineApp } from "@/features/apps"
import { InlineObject } from "@/features/objects"
import { FileAttachments } from "@/features/files"
import type { FileInfo } from "@/workspace/files"
import type { TimelineItem } from "../../conversations/contracts"
import { Markdown } from "../../components/markdown"
import { Button } from "../../components/ui/button"
import {
  Message,
  MessageContent,
  MessageFooter,
} from "../../components/ui/message"
import { Bubble, BubbleContent } from "../../components/ui/bubble"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../../components/ui/collapsible"

export function TurnActivity({
  items,
  toolTitles,
  agentId,
  onAppPendingChange,
}: {
  toolTitles?: Record<string, string>
  items: readonly TimelineItem[]
  agentId?: string
  onAppPendingChange?: (key: string, pending: boolean) => void
}) {
  return (
    <div className="turn-timeline">
      {items.map((item) => {
        if (item.type === "steer")
          return (
            <SteeringMessage
              key={item.id}
              text={item.text}
              attachments={item.attachments}
              agentId={agentId}
              label="Steered this reply"
            />
          )
        if (item.type === "text")
          return <Markdown key={item.id} text={item.text} />
        if (item.type === "thinking")
          return (
            <Collapsible key={item.id} className="group/thinking thinking-step">
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="thinking-trigger"
                  />
                }
              >
                <Brain /> Thinking{" "}
                <ChevronRight className="ml-auto group-data-open/thinking:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent className="thinking-details">
                <Markdown text={item.text} />
              </CollapsibleContent>
            </Collapsible>
          )
        const StatusIcon =
          item.status === "done"
            ? CircleCheck
            : ["error", "interrupted"].includes(item.status)
              ? CircleAlert
              : LoaderCircle
        return (
          <Fragment key={item.id}>
            <Collapsible
              className="group/tool tool-step"
              data-status={item.status}
            >
              <CollapsibleTrigger
                render={
                  <Button variant="ghost" className="tool-step-trigger" />
                }
              >
                <Wrench className="shrink-0" />
                <span className="tool-step-title">
                  {toolTitles?.[item.name] ?? item.name}
                </span>
                <span className="tool-step-status">
                  <StatusIcon
                    className={
                      item.status === "running"
                        ? "motion-safe:animate-spin"
                        : ""
                    }
                  />
                  {item.status === "done"
                    ? "Complete"
                    : item.status === "error"
                      ? "Failed"
                      : item.status === "interrupted"
                        ? "Interrupted"
                        : item.status === "pending"
                          ? "Queued"
                          : "Running"}
                  <ChevronRight className="group-data-open/tool:rotate-90" />
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="tool-step-details">
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">
                    Input
                  </p>
                  <pre className="max-h-56 overflow-auto text-xs break-all whitespace-pre-wrap">
                    {item.input}
                  </pre>
                </div>
                {item.output && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">
                      Result
                    </p>
                    <pre className="max-h-72 overflow-auto text-xs break-all whitespace-pre-wrap">
                      {item.output}
                    </pre>
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
            {agentId &&
              ["create_checklist", "read_object", "update_checklist"].includes(
                item.name
              ) &&
              item.status === "done" &&
              item.output && <InlineObject output={item.output} />}
            {agentId &&
              item.name === "publish_app" &&
              item.status === "done" &&
              item.output && (
                <InlineApp
                  agentId={agentId}
                  output={item.output}
                  onPendingChange={onAppPendingChange}
                />
              )}
          </Fragment>
        )
      })}
    </div>
  )
}

export function SteeringMessage({
  text,
  label,
  attachments,
  agentId,
}: {
  text: string
  label: string
  attachments?: readonly FileInfo[]
  agentId?: string
}) {
  return (
    <Message align="end" className="owner-message steering-message">
      <MessageContent>
        <Bubble align="end" variant="secondary">
          <BubbleContent className="message-text">
            {text}
            {agentId && (
              <FileAttachments files={attachments ?? []} agentId={agentId} />
            )}
            <MessageFooter>{label}</MessageFooter>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}
