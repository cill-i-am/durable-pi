import { Schema } from "effect"
import { ArrowRight, ChevronDown, Clock3, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import {
  ActivityFilter as importedFilter,
  ActivityPage,
  type ActivityCursor,
  type ActivityAgent,
  type ActivityEntry,
} from "@/activity/contracts"
import { AgentMark, agentTone } from "@/components/agent-mark"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"
import type { WorkspaceQuery } from "@/navigation/workspace"
import { parseAgentId } from "@/navigation/workspace"

import { ActivityRecord } from "./activity-record"

export function ActivityTimeline({
  agent,
  agents,
  onDetails,
  onOpenBot,
  onMemory,
  record,
  onRecordChange: setRecord,
  filters,
  onFiltersChange,
}: {
  filters: Pick<WorkspaceQuery, "scope" | "filter" | "cursor">
  onFiltersChange: (
    value: Pick<WorkspaceQuery, "scope" | "filter" | "cursor">
  ) => void
  record: Pick<ActivityEntry, "agent" | "reference"> | null
  onRecordChange: (
    record: Pick<ActivityEntry, "agent" | "reference"> | null
  ) => void
  agent: ActivityAgent
  agents: readonly ActivityAgent[]
  onDetails: (agent: ActivityAgent) => void
  onOpenBot: (id: ActivityAgent["id"]) => void
  onMemory: (id: ActivityAgent["id"]) => void
}) {
  const scope = filters.scope ?? agent.id
  const filter = filters.filter ?? "all"
  const cursor = filters.cursor ?? null
  const setCursor = (value: ActivityCursor | null) =>
    onFiltersChange({ ...filters, cursor: value ?? undefined })
  const [page, setPage] = useState<ActivityPage | null>(null)
  const [error, setError] = useState("")
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setPage(null)
    setError("")
    const request = agentApi(scope === "all" ? agent.id : scope)
    const params = new URLSearchParams({
      scope: scope === "all" ? "all" : "bot",
      filter,
    })
    if (cursor) params.set("cursor", JSON.stringify(cursor))
    const stop = poll(
      async () => {
        if (document.visibilityState !== "visible") return
        try {
          const value = Schema.decodeUnknownSync(ActivityPage)(
            await request(`activity?${params}`, undefined, controller.signal)
          )
          if (current) {
            setPage(value)
            setError("")
          }
        } catch (cause) {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "Activity could not reconnect."
            )
        }
      },
      cursor ? 15000 : 5000,
      true
    )
    return () => {
      current = false
      controller.abort()
      stop()
    }
  }, [agent.id, scope, filter, cursor, retry])
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="workbench-title">Activity</h2>
        <Select<string>
          value={scope}
          onValueChange={(value) => {
            if (value) {
              onFiltersChange({
                ...filters,
                scope: value === "all" ? "all" : parseAgentId(value),
                cursor: undefined,
              })
            }
          }}
        >
          <SelectTrigger className="max-w-full" aria-label="Activity agent">
            <SelectValue>
              {scope === "all"
                ? "All agents"
                : (agents.find((value) => value.id === scope)?.name ??
                  "This agent")}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">All agents</SelectItem>
              {agents.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="activity-filters">
        <ToggleGroup
          value={[filter]}
          onValueChange={(values) => {
            if (values[0]) {
              onFiltersChange({
                ...filters,
                filter: Schema.decodeUnknownSync(importedFilter)(values[0]),
                cursor: undefined,
              })
            }
          }}
          aria-label="Filter activity"
          className="justify-start"
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="attention">Needs you</ToggleGroupItem>
          <ToggleGroupItem value="running">Running</ToggleGroupItem>
        </ToggleGroup>
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onDetails(agents.find((value) => value.id === scope) ?? agent)
          }
        >
          Task details <ArrowRight />
        </Button>
      </div>
      <TimelineAvailability
        page={page}
        error={error}
        onRetry={() => setRetry((value) => value + 1)}
        onMemory={onMemory}
      />
      <section className="flex flex-col divide-y" aria-label="Recent activity">
        {page?.entries.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="activity-event"
            onClick={() =>
              entry.target === "background"
                ? onDetails(entry.agent)
                : setRecord(entry)
            }
          >
            <span className="flex min-w-0 items-start gap-3">
              <time
                dateTime={entry.at}
                className="w-11 shrink-0 pt-0.5 text-xs text-muted-foreground"
              >
                {new Date(entry.at).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </time>
              <AgentMark
                tone={agentTone(entry.agent.id)}
                className="size-6 shrink-0"
              />
              <span className="min-w-0 flex-1">
                <span className="block text-xs text-muted-foreground">
                  {entry.agent.name} · {new Date(entry.at).toLocaleDateString()}
                </span>
                <span className="line-clamp-3 text-sm font-medium">
                  {entry.title || "Attached files"}
                </span>
              </span>
              <ArrowRight className="mt-1 size-4 shrink-0 text-muted-foreground" />
            </span>
            <span className="activity-event-meta">
              <span>
                {entry.kind === "steer"
                  ? "Steering"
                  : entry.kind === "tool"
                    ? "Tool operation"
                    : entry.kind === "background"
                      ? "Background drafting"
                      : "Conversation"}
              </span>
              <Badge variant={entry.attention ? "outline" : "secondary"}>
                {entry.attention ? "Needs you" : entry.status}
              </Badge>
            </span>
          </button>
        ))}
      </section>
      {page &&
        !page.entries.length &&
        !page.issues.length &&
        !page.unavailable.length &&
        !error && (
          <p className="py-6 text-sm text-muted-foreground">
            {filter === "attention"
              ? "Nothing needs your attention here."
              : filter === "running"
                ? "No work is running here."
                : "No activity in this view yet."}
          </p>
        )}
      <div className="flex flex-wrap justify-between gap-3">
        {cursor && (
          <Button variant="ghost" size="sm" onClick={() => setCursor(null)}>
            Latest activity
          </Button>
        )}
        {page?.next && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setCursor(page.next)}
          >
            Earlier activity <ChevronDown />
          </Button>
        )}
      </div>
      {record && (
        <ActivityRecord
          key={`${record.agent.id}:${record.reference}`}
          entry={record}
          onClose={() => setRecord(null)}
          onOpenBot={() => onOpenBot(record.agent.id)}
        />
      )}
    </>
  )
}

function TimelineAvailability({
  page,
  error,
  onRetry,
  onMemory,
}: {
  page: ActivityPage | null
  error: string
  onRetry: () => void
  onMemory: Parameters<typeof ActivityTimeline>[0]["onMemory"]
}) {
  return (
    <>
      {error && (
        <Alert>
          <AlertTitle>Updates interrupted</AlertTitle>
          <AlertDescription>
            {error}
            <Button variant="outline" size="sm" onClick={onRetry}>
              <RefreshCw /> Reconnect
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!page && !error && <Skeleton className="h-32 w-full" />}
      {!!page?.unavailable.length && (
        <Alert>
          <AlertTitle>Some agents could not be reached</AlertTitle>
          <AlertDescription>
            {page.unavailable.map((value) => value.name).join(", ")}. Their
            activity may be missing. Reconnecting automatically.
          </AlertDescription>
        </Alert>
      )}
      {page?.issues.map((issue) => (
        <Alert key={issue.key}>
          <Clock3 />
          <AlertTitle>
            {issue.agent.name} · {issue.title}
          </AlertTitle>
          <AlertDescription>
            {issue.detail}
            {issue.target === "memory" ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => onMemory(issue.agent.id)}
              >
                Open Memory
              </Button>
            ) : (
              <a
                href="https://github.com/cill-i-am/durable-pi#run-it"
                target="_blank"
                rel="noreferrer"
                data-slot="button"
                className={buttonVariants({ variant: "outline", size: "sm" })}
              >
                Connection setup
              </a>
            )}
          </AlertDescription>
        </Alert>
      ))}
    </>
  )
}
