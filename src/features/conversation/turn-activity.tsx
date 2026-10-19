import { Link } from "@tanstack/react-router"
import { Option, Schema } from "effect"
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
import { lazy, Suspense, useState } from "react"

import { AgentId } from "@/agents/contracts"
import { CopyButton } from "@/components/copy-button"
import { Badge } from "@/components/ui/badge"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockContent,
} from "@/components/ui/code-block"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
} from "@/components/ui/trace"
import { InlineApp } from "@/features/apps/inline-app"
import { FileAttachments } from "@/features/files"
import { InlineObject } from "@/features/objects/checklist"
import type { MessageProvenance } from "@/messages/identity"
import { workspaceDestination } from "@/navigation/workspace"
import { richResultToolNames } from "@/rich-results/contracts"
import type { FileInfo } from "@/workspace/files"

import { Markdown } from "../../components/markdown"
import { Bubble, BubbleContent } from "../../components/ui/bubble"
import {
  Message,
  MessageContent,
  MessageFooter,
} from "../../components/ui/message"
import type { ChatState, TimelineItem } from "../../conversations/contracts"
import {
  activitySections,
  toolPresentation,
  workPresentation,
  type ToolItem,
  type WorkItem,
} from "./activity-presentation"

const RichResult = lazy(() =>
  import("@/features/rich-results/rich-result").then((module) => ({
    default: module.RichResult,
  }))
)

export function TurnActivity({
  items,
  toolTitles,
  agentId,
  status = "done",
  waitingForApproval = false,
  onAppPendingChange,
  onAnswerPrompt,
}: {
  toolTitles?: Record<string, string>
  items: readonly TimelineItem[]
  agentId?: string
  status?: ChatState["turns"][number]["status"]
  waitingForApproval?: boolean
  onAppPendingChange?: (key: string, pending: boolean) => void
  onAnswerPrompt?: (text: string) => void
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
              provenance={item.provenance}
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
        if (richResultToolNames.some((name) => name === result.name))
          return (
            <Suspense
              key={item.id}
              fallback={
                <Skeleton
                  className="h-40 w-full"
                  aria-label="Loading interactive answer"
                />
              }
            >
              <RichResult output={result.output} onPrompt={onAnswerPrompt} />
            </Suspense>
          )
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
    <Trace>
      <TraceCollapsible
        open={expanded ?? view.defaultOpen}
        onOpenChange={setExpanded}
      >
        <TraceCollapsibleTrigger>
          <TraceLine
            status={
              view.active ? "running" : view.attention ? "error" : undefined
            }
          >
            <TraceIcon>
              {view.active ? (
                <Wrench />
              ) : view.paused ? (
                <Pause />
              ) : view.attention ? (
                <CircleAlert />
              ) : view.count ? (
                <CircleCheck />
              ) : (
                <Brain />
              )}
            </TraceIcon>
            <TraceTitle>{view.label}</TraceTitle>
            {!!view.count && (
              <TraceDescription>
                {view.count} {view.count === 1 ? "step" : "steps"}
              </TraceDescription>
            )}
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent onFocusCapture={() => setExpanded(true)}>
          <Trace role="group" aria-label="Recorded agent activity">
            {items.map((item, index) =>
              item.type === "thinking" ? (
                <ReasoningActivity
                  key={item.id}
                  text={item.text}
                  running={view.active && current && index === items.length - 1}
                />
              ) : (
                <ToolActivity
                  key={item.id}
                  item={item}
                  title={toolTitles?.[item.name]}
                  agentId={agentId}
                  runStatus={status}
                  waitingForApproval={waitingForApproval}
                />
              )
            )}
          </Trace>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}

function ReasoningActivity({
  text,
  running,
}: {
  text: string
  running: boolean
}) {
  const [expanded, setExpanded] = useState<boolean | null>(null)
  return (
    <TraceCollapsible open={expanded ?? running} onOpenChange={setExpanded}>
      <TraceCollapsibleTrigger>
        <TraceLine status={running ? "running" : undefined}>
          <TraceIcon>
            <Brain />
          </TraceIcon>
          <TraceTitle>{running ? "Thinking" : "Thought"}</TraceTitle>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Markdown text={text} />
      </TraceCollapsibleContent>
    </TraceCollapsible>
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
    <a
      href={source.href}
      target="_blank"
      rel="noreferrer noopener"
      title={source.href}
      aria-label={source.label}
      className="flex min-h-11 max-w-full items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50 md:min-h-6"
    >
      <TraceLine>
        <TraceIcon>
          {favicon && unavailableIcon !== favicon ? (
            <img
              src={favicon}
              alt=""
              width={16}
              height={16}
              loading="lazy"
              decoding="async"
              referrerPolicy="no-referrer"
              onError={() => setUnavailableIcon(favicon)}
            />
          ) : (
            <Globe />
          )}
        </TraceIcon>
        <TraceTitle>{source.label}</TraceTitle>
        <TraceIcon>
          <ArrowUpRight />
        </TraceIcon>
        <span className="sr-only"> (opens in a new tab)</span>
      </TraceLine>
    </a>
  )
}

const toolIcons: Partial<
  Record<ReturnType<typeof toolPresentation>["kind"], typeof Wrench>
> = {
  browser: Globe,
  search: Search,
  terminal: Terminal,
  code: CodeXml,
  file: FileText,
}

function toolActivityLabel(
  item: ToolItem,
  runStatus: ChatState["turns"][number]["status"],
  waitingForApproval: boolean
) {
  const label =
    ["running", "pending"].includes(item.status) &&
    ["done", "failed", "cancelled", "stopping"].includes(runStatus)
      ? runStatus === "stopping"
        ? "Stopping…"
        : runStatus === "cancelled"
          ? "Stopped"
          : "Interrupted"
      : waitingForApproval && ["running", "pending"].includes(item.status)
        ? "Waiting for approval"
        : item.status === "done"
          ? "Complete"
          : item.status === "error"
            ? "Failed"
            : item.status === "interrupted"
              ? "Interrupted"
              : item.status === "pending"
                ? "Queued"
                : "Running"
  return label
}

function toolTraceStatus(label: string) {
  const traceStatus =
    label === "Running"
      ? "running"
      : label === "Queued" || label === "Waiting for approval"
        ? "pending"
        : label === "Failed" || label === "Interrupted"
          ? "error"
          : undefined
  return traceStatus
}

function ToolActivity({
  item,
  title,
  agentId,
  runStatus,
  waitingForApproval,
}: {
  item: ToolItem
  title?: string
  agentId?: string
  runStatus: ChatState["turns"][number]["status"]
  waitingForApproval: boolean
}) {
  const view = toolPresentation(item)
  const owner = Schema.decodeUnknownOption(AgentId)(agentId)
  const Icon = toolIcons[view.kind] ?? Wrench
  const label = toolActivityLabel(item, runStatus, waitingForApproval)
  const traceStatus = toolTraceStatus(label)
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>
        <TraceLine status={traceStatus}>
          <TraceIcon>
            <Icon />
          </TraceIcon>
          <TraceTitle>
            {title && title !== item.name
              ? title
              : item.name.charAt(0).toUpperCase() +
                item.name.slice(1).replaceAll("_", " ")}
          </TraceTitle>
          <TraceDescription>{label}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      {view.sources[0] && (
        <Trace className="my-1">
          <SourceLink source={view.sources[0]} />
        </Trace>
      )}
      {view.destination && Option.isSome(owner) && (
        <Badge
          variant="outline"
          className="my-1 min-h-11 w-fit max-w-full md:min-h-6"
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
      <TraceCollapsibleContent className="flex flex-col gap-3">
        <ToolDetail title="Input" text={item.input} />
        {item.output && <ToolDetail title="Result" text={item.output} />}
        {view.sources.length > 1 && (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceIcon>
                    <Globe />
                  </TraceIcon>
                  <TraceTitle>Page links</TraceTitle>
                  <TraceDescription>{view.sources.length - 1}</TraceDescription>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent>
                <Trace>
                  {view.sources.slice(1).map((source) => (
                    <SourceLink key={source.href} source={source} />
                  ))}
                </Trace>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function ToolDetail({ title, text }: { title: string; text: string }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
        <CodeBlockActions>
          <CopyButton text={text} label={`Copy tool ${title.toLowerCase()}`} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-72">
        {text}
      </CodeBlockContent>
    </CodeBlock>
  )
}

export function SteeringMessage({
  text,
  label,
  attachments,
  agentId,
  provenance,
}: {
  text: string
  label: string
  attachments?: readonly FileInfo[]
  agentId?: string
  provenance?: MessageProvenance
}) {
  const internal = provenance && provenance.author.kind !== "human"
  return (
    <Message
      align={internal ? "start" : "end"}
      className={`${internal ? "background-message" : "owner-message"} steering-message`}
    >
      <MessageContent>
        <Bubble
          align={internal ? "start" : "end"}
          variant={internal ? "muted" : "secondary"}
        >
          <BubbleContent className="message-text">
            {internal && (
              <>
                <strong>
                  {provenance.author.kind === "agent"
                    ? "Agent message"
                    : "Automated message"}
                </strong>
                <br />
              </>
            )}
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
