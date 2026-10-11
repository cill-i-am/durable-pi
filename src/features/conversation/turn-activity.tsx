import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  LoaderCircle,
  Wrench,
} from "lucide-react"
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
}: {
  toolTitles?: Record<string, string>
  items: readonly TimelineItem[]
  agentId?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
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
            <Collapsible key={item.id} className="group/thinking">
              <CollapsibleTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                  />
                }
              >
                <Brain /> Thinking{" "}
                <ChevronRight className="ml-auto group-data-open/thinking:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent className="border-l pl-4 text-sm text-muted-foreground">
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
          <Collapsible
            key={item.id}
            className="group/tool rounded-lg border bg-muted/30"
          >
            <CollapsibleTrigger
              render={
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start px-3 py-2"
                />
              }
            >
              <Wrench className="shrink-0" />
              <span className="truncate font-mono text-xs">
                {toolTitles?.[item.name] ?? item.name}
              </span>
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                <StatusIcon
                  className={
                    item.status === "running" ? "motion-safe:animate-spin" : ""
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
            <CollapsibleContent className="space-y-3 border-t px-3 py-3">
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
    <Message align="end">
      <MessageContent>
        <Bubble align="end" variant="secondary">
          <BubbleContent className="message-text">
            {text}
            {agentId && (
              <FileAttachments files={attachments ?? []} agentId={agentId} />
            )}
          </BubbleContent>
        </Bubble>
        <MessageFooter>{label}</MessageFooter>
      </MessageContent>
    </Message>
  )
}
