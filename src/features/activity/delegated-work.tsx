import { Schema } from "effect"
import { GitBranch, Square } from "lucide-react"
import { useEffect, useState } from "react"

import { CopyButton } from "@/components/copy-button"
import { Markdown } from "@/components/markdown"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockContent,
} from "@/components/ui/code-block"
import { Field, FieldLabel, FieldGroup } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  Trace,
  TraceLine,
  TraceIcon,
  TraceTitle,
  TraceDescription,
  TraceCollapsible,
  TraceCollapsibleTrigger,
  TraceCollapsibleContent,
} from "@/components/ui/trace"
import { Group, Transcript, type Child } from "@/delegation/contracts"

import { BackgroundActions } from "./background-actions"
import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"
import { useTaskControl } from "./use-task-control"

const Page = Schema.Struct({
  groups: Schema.Array(Group),
  nextOffset: Schema.NullOr(Schema.Number),
})
export function DelegatedWork({
  agentId,
  background = false,
}: {
  agentId: string
  background?: boolean
}) {
  const prefix = background ? "background" : "delegations"
  const [offset, setOffset] = useState(0)
  const path = `${prefix}?offset=${offset}`
  const query = useActivityQuery({
    key: JSON.stringify([agentId, path]),
    interval: 2000,
    read: async (signal) =>
      Schema.decodeUnknownSync(Page)(
        await activityJsonRequest(agentId, path, signal)
      ),
    errorMessage: "Delegated work could not reconnect.",
  })
  const page = query.data ?? { groups: [], nextOffset: null }
  const error = query.error
  if (!page.groups.length && !error && offset === 0) return null
  return (
    <section
      className="flex min-w-0 flex-col gap-[18px]"
      aria-label={background ? "Background work" : "Delegated work"}
    >
      <div className="flex flex-col gap-2">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <GitBranch className="size-4" />{" "}
          {background ? "In the background" : "Working together"}
        </h3>
        <p className="text-sm text-muted-foreground">
          {background
            ? "Private drafting tasks continue while you chat. Their findings arrive here when ready."
            : "Independent branches of the same request. Your agent brings the results together."}
        </p>
      </div>
      {error && (
        <Alert>
          <AlertTitle>Updates interrupted</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refresh()}
            >
              Reconnect
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {page.groups.map((group) => (
        <DelegationGroup key={group.id} group={group} agentId={agentId} />
      ))}
      <div className="flex flex-wrap justify-between gap-2">
        {offset > 0 && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset(Math.max(0, offset - 20))}
          >
            Newer groups
          </Button>
        )}
        {page.nextOffset !== null && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setOffset(page.nextOffset!)}
          >
            Earlier groups
          </Button>
        )}
      </div>
    </section>
  )
}
export function DelegationGroup({
  group,
  agentId,
}: {
  group: Group
  agentId: string
}) {
  const done = group.children.filter((child) =>
    ["completed", "failed", "cancelled"].includes(child.status)
  ).length
  return (
    <Trace>
      <TraceCollapsible defaultOpen>
        <TraceCollapsibleTrigger>
          <TraceLine
            className="flex-wrap"
            status={group.status === "working" ? "running" : undefined}
          >
            <TraceIcon>
              <GitBranch />
            </TraceIcon>
            <TraceTitle title={group.objective}>{group.objective}</TraceTitle>
            <TraceDescription>
              {done} of {group.children.length} settled
            </TraceDescription>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent keepMounted className="flex flex-col gap-3">
          <p className="text-sm text-foreground">{group.objective}</p>
          <p className="text-xs">
            {group.background
              ? group.background.stop === "unconfirmed"
                ? "Stop unconfirmed"
                : group.background.stop === "pending"
                  ? "Stop pending"
                  : group.background.delivery
              : group.status === "completed"
                ? "Report ready"
                : group.status === "cancelled"
                  ? "Stopped with parent"
                  : group.detached
                    ? "Agents can exchange messages while the parent continues"
                    : "Parent is waiting for results"}
          </p>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary">{group.route.model}</Badge>
            <Badge variant="outline">{group.route.thinking}</Badge>
          </div>
          {group.background && (
            <BackgroundActions agentId={agentId} group={group} />
          )}
          <Trace role="group" aria-label="Delegated branches">
            {group.children.map((child) => (
              <ChildTrace
                key={child.id}
                child={child}
                group={group}
                agentId={agentId}
              />
            ))}
          </Trace>
          <p className="text-xs">
            {group.background
              ? "Shared: a text reference snapshot and each child’s brief. No tools or live retrieval. Up to 12 requests per child and 10 minutes per group. Send revised requirements with the child’s steering control."
              : "Shared: this bot’s reference context and parent steering. Selected read tools only. Up to 12 model requests per child and 10 minutes per group; stopping the parent stops its children."}
          </p>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  )
}
function childPresentation(child: Child, group: Group) {
  const unsettled = ["queued", "working", "stopping"].includes(child.status)
  const running =
    group.status === "working" &&
    (unsettled || (!!group.detached && child.status === "completed"))
  const label =
    unsettled && group.status !== "working"
      ? group.background?.stop === "unconfirmed"
        ? "Stop unconfirmed"
        : group.background?.stop === "pending"
          ? "Stop pending"
          : group.status === "cancelled"
            ? "Stopped with parent"
            : "Interrupted"
      : group.detached && running && child.status === "completed"
        ? "Idle · available for messages"
        : child.status
  const status =
    label === "Interrupted" || child.status === "failed"
      ? "error"
      : running && child.status === "working"
        ? "running"
        : running && child.status === "queued"
          ? "pending"
          : undefined
  return { running, label, status } as const
}

function controlLabel(
  action: "stop" | "steer",
  busy: boolean,
  uncertain: boolean
) {
  if (busy) return "Sending…"
  if (uncertain) return `Retry saved ${action}`
  return action === "stop" ? "Stop task" : "Send steering"
}

function ChildTrace({
  child,
  group,
  agentId,
}: {
  child: Child
  group: Group
  agentId: string
}) {
  const [inspect, setInspect] = useState(false)
  const [expanded, setExpanded] = useState<boolean | null>(null)
  const { running, label, status } = childPresentation(child, group)
  const prefix = group.background ? "background" : "delegations"
  const controls = useTaskControl({
    agentId,
    groupId: group.id,
    childId: child.id,
    prefix,
    active: running && child.status !== "stopping" ? ["stop", "steer"] : [],
  })
  return (
    <TraceCollapsible
      open={expanded ?? (running || !!child.error)}
      onOpenChange={setExpanded}
    >
      <TraceCollapsibleTrigger>
        <TraceLine status={status}>
          <TraceIcon>
            <GitBranch />
          </TraceIcon>
          <TraceTitle title={child.name}>{child.name}</TraceTitle>
          <TraceDescription>{label}</TraceDescription>
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent keepMounted className="flex flex-col gap-3">
        <p className="text-sm text-foreground">{child.task}</p>
        <div className="flex flex-wrap gap-2">
          {child.tools.length ? (
            child.tools.map((tool) => (
              <Badge key={tool} variant="outline">
                {tool}
              </Badge>
            ))
          ) : (
            <Badge variant="outline">No tools</Badge>
          )}
          <Badge variant="secondary">{child.requests}/12 requests</Badge>
        </div>
        {child.inputTokens !== null && (
          <p className="text-xs">
            {child.inputTokens.toLocaleString()} input ·{" "}
            {child.outputTokens?.toLocaleString()} output tokens, including
            compaction
          </p>
        )}
        {child.error && (
          <Alert>
            <AlertDescription>{child.error}</AlertDescription>
          </Alert>
        )}
        {child.answer && <Markdown text={child.answer} />}
        {!!child.steering.length && (
          <Trace>
            <TraceCollapsible>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceTitle>Steering history</TraceTitle>
                  <TraceDescription>{child.steering.length}</TraceDescription>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent keepMounted>
                <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
                  {child.steering.map((text, i) => (
                    <li key={i}>{text}</li>
                  ))}
                </ol>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          </Trace>
        )}
        <ChildControl
          controls={controls}
          groupId={group.id}
          prefix={prefix}
          child={child}
          action="steer"
          active={running && child.status !== "stopping"}
        />
        {inspect && (
          <ChildTranscript
            key={child.id}
            agentId={agentId}
            groupId={group.id}
            prefix={prefix}
            childId={child.id}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setInspect(!inspect)}
          >
            {inspect ? "Close task" : "Open task"}
          </Button>
          <ChildControl
            controls={controls}
            groupId={group.id}
            prefix={prefix}
            child={child}
            action="stop"
            active={running && child.status !== "stopping"}
          />
        </div>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

function ChildControl({
  groupId,
  child,
  action,
  active,
  prefix,
  controls,
}: {
  groupId: number
  child: Child
  action: "stop" | "steer"
  active: boolean
  prefix: string
  controls: ReturnType<typeof useTaskControl>
}) {
  const [text, setText] = useState("")
  const saved = controls.saved(action)
  const uncertain = !!saved
  const busy = controls.busy
  const error = controls.error
  const acknowledged = controls.acknowledged
  useEffect(() => {
    if (
      acknowledged?.kind === "child" &&
      acknowledged.body.action.type === action
    )
      setText("")
  }, [acknowledged, action])
  if (!active && !uncertain && !error) return null
  const button = (
    <Button
      size="sm"
      variant="outline"
      disabled={
        controls.blocked(action) ||
        (action === "steer" && !uncertain && !text.trim())
      }
      onClick={() => controls.submit(action, text)}
    >
      {action === "stop" && <Square data-icon="inline-start" />}
      {controlLabel(action, controls.sending, uncertain)}
    </Button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {action === "steer" ? (
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor={`${prefix}-steer-${groupId}-${child.id}`}>
              Steer {child.name}
            </FieldLabel>
            <Textarea
              id={`${prefix}-steer-${groupId}-${child.id}`}
              value={
                uncertain &&
                saved?.kind === "child" &&
                saved.body.action.type === "steer"
                  ? saved.body.action.text
                  : text
              }
              maxLength={8000}
              disabled={busy || uncertain || !active}
              onChange={(event) => setText(event.target.value)}
              placeholder="Refine this branch’s brief…"
            />
            {button}
          </Field>
        </FieldGroup>
      ) : (
        button
      )}
      {uncertain && (
        <p className="text-xs text-muted-foreground">
          Saved control awaiting acknowledgement. Retry sends the same
          operation.
        </p>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
function ChildTranscript({
  agentId,
  groupId,
  childId,
  prefix,
}: {
  agentId: string
  groupId: number
  childId: number
  prefix: string
}) {
  const [cursor, setCursor] = useState<string | undefined>()
  const path = `${prefix}/${groupId}/${childId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`
  const query = useActivityQuery({
    key: JSON.stringify([agentId, path]),
    interval: cursor ? 10000 : 2000,
    read: async (signal) =>
      Schema.decodeUnknownSync(Transcript)(
        await activityJsonRequest(agentId, path, signal)
      ),
    errorMessage: "Task could not load.",
  })
  const page = query.data
  const error = query.error
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Child transcript"
    >
      <h4 className="text-sm font-medium">Native task history</h4>
      <p className="text-xs text-muted-foreground">
        Newest first. Large entries are shortened for display; originals remain
        in the child conversation.
      </p>
      {error ? (
        <Alert>
          <AlertDescription>
            {error}
            <Button
              size="sm"
              variant="outline"
              onClick={() => void query.refresh()}
            >
              Reconnect
            </Button>
          </AlertDescription>
        </Alert>
      ) : !page ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <Trace>
          {page.entries.map((entry) => (
            <TraceCollapsible key={entry.id}>
              <TraceCollapsibleTrigger>
                <TraceLine>
                  <TraceTitle>{entry.kind.replace("pi.", "")}</TraceTitle>
                  <TraceDescription>{entry.id}</TraceDescription>
                </TraceLine>
              </TraceCollapsibleTrigger>
              <TraceCollapsibleContent keepMounted>
                <CodeBlock size="sm">
                  <CodeBlockHeader>
                    <CodeBlockTitle>Saved entry</CodeBlockTitle>
                    <CodeBlockActions>
                      <CopyButton text={entry.text} label="Copy task entry" />
                    </CodeBlockActions>
                  </CodeBlockHeader>
                  <CodeBlockContent wrap className="max-h-80">
                    {entry.text}
                  </CodeBlockContent>
                </CodeBlock>
              </TraceCollapsibleContent>
            </TraceCollapsible>
          ))}
        </Trace>
      )}
      <div className="flex flex-wrap gap-2">
        {cursor && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setCursor(undefined)}
          >
            Latest entries
          </Button>
        )}
        {page?.cursor && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCursor(page.cursor!)}
          >
            Earlier entries
          </Button>
        )}
      </div>
    </section>
  )
}
