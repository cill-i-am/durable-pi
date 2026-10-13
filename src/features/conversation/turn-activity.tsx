import {
  Brain,
  ChevronRight,
  CircleCheck,
  CircleAlert,
  Globe,
  Search,
  Terminal,
  CodeXml,
  FileText,
  Pause,
  ArrowUpRight,
  Wrench,
} from "lucide-react"
import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { Option, Schema } from "effect"
import { AgentId } from "@/agents/contracts"
import { workspaceDestination } from "@/navigation/workspace"
import { ActivityOrb } from "@/components/activity-visuals"
import { CopyButton } from "@/components/copy-button"
import { Badge } from "@/components/ui/badge"
import { InlineApp } from "@/features/apps"
import { InlineObject } from "@/features/objects"
import { FileAttachments } from "@/features/files"
import type { FileInfo } from "@/workspace/files"
import type { ChatState, TimelineItem } from "../../conversations/contracts"
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
import {
  activitySections,
  toolPresentation,
  workPresentation,
  type ToolItem,
  type WorkItem,
} from "./activity-presentation"

export function TurnActivity({
  items,
  toolTitles,
  agentId,
  status = "done",
  waitingForApproval = false,
  onAppPendingChange,
}: {
  toolTitles?: Record<string, string>
  items: readonly TimelineItem[]
  agentId?: string
  status?: ChatState["turns"][number]["status"]
  waitingForApproval?: boolean
  onAppPendingChange?: (key: string, pending: boolean) => void
}) {
  const sections = activitySections(items)
  return (
    <div className="turn-timeline">
      {sections.map((item, index) => {
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
        if (item.type === "work")
          return (
            <WorkGroup
              key={`work:${item.id}`}
              items={item.items}
              status={status}
              current={index === sections.length - 1}
              waitingForApproval={waitingForApproval}
              toolTitles={toolTitles}
              agentId={agentId}
            />
          )
        const result = item.item
        return (
          agentId &&
          (result.name === "publish_app" ? (
            <InlineApp
              key={item.id}
              agentId={agentId}
              output={result.output}
              onPendingChange={onAppPendingChange}
            />
          ) : (
            <InlineObject key={item.id} output={result.output} />
          ))
        )
      })}
    </div>
  )
}

function WorkGroup({
  items,
  status,
  current,
  waitingForApproval,
  toolTitles,
  agentId,
}: {
  items: readonly WorkItem[]
  status: ChatState["turns"][number]["status"]
  current: boolean
  waitingForApproval: boolean
  toolTitles?: Record<string, string>
  agentId?: string
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const view = workPresentation(items, status, current, waitingForApproval)
  return (
    <Collapsible
      className="group/work activity-group"
      open={expanded ?? view.defaultOpen}
      onOpenChange={setExpanded}
    >
      <CollapsibleTrigger
        render={<Button variant="ghost" className="activity-group-trigger" />}
      >
        <span className="activity-icon-lane">
          {view.active ? (
            <ActivityOrb
              state={
                view.label === "Browsing"
                  ? "connecting"
                  : view.label === "Searching memory"
                    ? "searching"
                    : "working"
              }
            />
          ) : view.paused ? (
            <Pause aria-hidden="true" />
          ) : view.attention ? (
            <CircleAlert aria-hidden="true" />
          ) : view.count ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <Brain aria-hidden="true" />
          )}
        </span>
        <span className="activity-group-label">{view.label}</span>
        {!!view.count && (
          <span className="activity-count">
            {view.count} {view.count === 1 ? "step" : "steps"}
          </span>
        )}
        <ChevronRight
          aria-hidden="true"
          className="group-data-open/work:rotate-90"
        />
      </CollapsibleTrigger>
      <CollapsibleContent onFocusCapture={() => setExpanded(true)}>
        <ol className="activity-trail" aria-label="Recorded agent activity">
          {items.map((item) => (
            <li key={item.id} className="activity-trail-item">
              {item.type === "thinking" ? (
                <Collapsible className="group/thinking thinking-step">
                  <CollapsibleTrigger
                    render={
                      <Button
                        variant="ghost"
                        className="thinking-trigger activity-row-trigger"
                      />
                    }
                  >
                    <span className="activity-icon-lane">
                      <Brain aria-hidden="true" />
                    </span>
                    <span className="tool-step-title">Thinking</span>
                    <ChevronRight
                      aria-hidden="true"
                      className="group-data-open/thinking:rotate-90"
                    />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="thinking-details">
                    <Markdown text={item.text} />
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <ToolActivity
                  item={item}
                  title={toolTitles?.[item.name]}
                  agentId={agentId}
                  runStatus={status}
                />
              )}
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SourceLink({
  source,
}: {
  source: ReturnType<typeof toolPresentation>["sources"][number]
}) {
  const [unavailableIcon, setUnavailableIcon] = useState<string | null>(null)
  const favicon = source.favicon
  return (
    <Badge
      variant="outline"
      className="activity-source"
      render={
        <a
          href={source.href}
          target="_blank"
          rel="noreferrer noopener"
          title={source.href}
        />
      }
    >
      <span
        className="activity-source-icon"
        data-icon="inline-start"
        aria-hidden="true"
      >
        {favicon && unavailableIcon !== favicon ? (
          <img
            src={favicon}
            alt=""
            width={14}
            height={14}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setUnavailableIcon(favicon)}
          />
        ) : (
          <Globe />
        )}
      </span>
      <span className="truncate">{source.label}</span>
      <ArrowUpRight aria-hidden="true" data-icon="inline-end" />
    </Badge>
  )
}

function ToolActivity({
  item,
  title,
  agentId,
  runStatus,
}: {
  item: ToolItem
  title?: string
  agentId?: string
  runStatus: ChatState["turns"][number]["status"]
}) {
  const view = toolPresentation(item)
  const owner = Schema.decodeUnknownOption(AgentId)(agentId)
  const Icon =
    view.kind === "browser"
      ? Globe
      : view.kind === "search"
        ? Search
        : view.kind === "terminal"
          ? Terminal
          : view.kind === "code"
            ? CodeXml
            : view.kind === "file"
              ? FileText
              : Wrench
  const label =
    ["running", "pending"].includes(item.status) &&
    ["done", "failed", "cancelled", "stopping"].includes(runStatus)
      ? runStatus === "stopping"
        ? "Stopping…"
        : runStatus === "cancelled"
          ? "Stopped"
          : "Interrupted"
      : item.status === "done"
        ? "Complete"
        : item.status === "error"
          ? "Failed"
          : item.status === "interrupted"
            ? "Interrupted"
            : item.status === "pending"
              ? "Queued"
              : "Running"
  return (
    <Collapsible className="group/tool tool-step" data-status={item.status}>
      <CollapsibleTrigger
        render={<Button variant="ghost" className="activity-row-trigger" />}
      >
        <span className="activity-icon-lane">
          <Icon aria-hidden="true" />
        </span>
        <span className="tool-step-title">
          {title && title !== item.name
            ? title
            : item.name.charAt(0).toUpperCase() +
              item.name.slice(1).replaceAll("_", " ")}
        </span>
        <span className="tool-step-status">{label}</span>
        <ChevronRight
          aria-hidden="true"
          className="group-data-open/tool:rotate-90"
        />
      </CollapsibleTrigger>
      <div className="activity-sources">
        {view.sources[0] && <SourceLink source={view.sources[0]} />}
        {view.destination && Option.isSome(owner) && (
          <Badge
            variant="outline"
            className="activity-source"
            render={
              <Link
                {...workspaceDestination(owner.value, view.destination.view)}
              />
            }
          >
            <span className="truncate">{view.destination.label}</span>
            <ChevronRight aria-hidden="true" data-icon="inline-end" />
          </Badge>
        )}
      </div>
      <CollapsibleContent className="tool-step-details">
        <ToolDetail title="Input" text={item.input} />
        {item.output && <ToolDetail title="Result" text={item.output} />}
        {view.sources.length > 1 && (
          <div className="flex min-w-0 flex-col gap-2">
            <p className="text-xs font-medium text-muted-foreground">
              Page links
            </p>
            <div className="flex min-w-0 flex-wrap gap-2">
              {view.sources.slice(1).map((source) => (
                <SourceLink key={source.href} source={source} />
              ))}
            </div>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolDetail({ title, text }: { title: string; text: string }) {
  return (
    <div className="activity-detail">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{title}</p>
        <CopyButton text={text} label={`Copy tool ${title.toLowerCase()}`} />
      </div>
      <pre className="max-h-72 overflow-auto overscroll-contain text-xs break-all whitespace-pre-wrap">
        {text}
      </pre>
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
