import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { Schema } from "effect"
import { ArrowUpRight, ChevronDown } from "lucide-react"

import { ActivityConversation } from "@/activity/contracts"
import type { RunActivity, RunEvent, RunCursor } from "@/activity/run"
import { CopyButton } from "@/components/copy-button"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"

import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"

const tracesUrl =
  "https://dash.cloudflare.com/862c7693f07f3e0cdca26eae399bf5e4/observability/traces"
export function elapsed(start: string | number, end: string | number) {
  const duration = Math.max(
    0,
    (typeof end === "number" ? end : Date.parse(end)) -
      (typeof start === "number" ? start : Date.parse(start))
  )
  return duration < 1000
    ? `${Math.round(duration)} ms`
    : `${(duration / 1000).toFixed(1)} s`
}

export function RunTimeline({
  run,
  agentId,
}: {
  run: RunActivity
  agentId: string
}) {
  const {
    data: older,
    busy,
    error,
    refresh,
    clear,
  } = useActivityQuery<RunActivity, RunCursor>({
    key: JSON.stringify(["run-history", agentId, run.runId]),
    auto: false,
    read: async (signal, cursor) => {
      const query = new URLSearchParams({ cursor: JSON.stringify(cursor) })
      const result = Schema.decodeUnknownSync(ActivityConversation)(
        await activityJsonRequest(
          agentId,
          `activity/conversations/${encodeURIComponent(run.runId)}?${query}`,
          signal
        )
      )
      if (!result.run || result.run.runId !== run.runId)
        throw new Error("Run details are unavailable. Reload and try again.")
      return result.run
    },
    errorMessage: "Earlier run records could not load. Try again.",
  })
  const page = older ?? run
  const earlier = () => (page.next ? refresh(page.next) : Promise.resolve())
  return (
    <section aria-label="Run timeline" className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Run timeline</h3>
        <Badge variant="secondary">{run.status}</Badge>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Elapsed, including waits</dt>
          <dd className="mt-1 font-medium">
            {run.finishedAt
              ? elapsed(run.createdAt, run.finishedAt)
              : ["done", "failed", "cancelled"].includes(run.status)
                ? "Not recorded"
                : "In progress"}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Model requests</dt>
          <dd className="mt-1 font-medium">{run.totals.modelRequests}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Known input / cached</dt>
          <dd className="mt-1 font-medium">
            {run.totals.knownInputTokens.toLocaleString()} /{" "}
            {run.totals.knownCachedInputTokens.toLocaleString()}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Known output</dt>
          <dd className="mt-1 font-medium">
            {run.totals.knownOutputTokens.toLocaleString()}
          </dd>
        </div>
      </dl>
      {run.totals.usageReportedRequests < run.totals.modelRequests && (
        <p className="text-xs text-muted-foreground">
          Usage reported for {run.totals.usageReportedRequests} of{" "}
          {run.totals.modelRequests} requests.
        </p>
      )}
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <ChevronDown /> Cloudflare correlation
        </CollapsibleTrigger>
        <CollapsibleContent className="flex min-w-0 flex-col gap-2 py-2 text-xs">
          <div className="flex min-w-0 items-center gap-2">
            <code className="min-w-0 break-all">{run.runId}</code>
            <CopyButton text={run.runId} label="Copy run ID" />
          </div>
          <p className="text-muted-foreground">
            Filter logs by <code>runId</code>, then open the associated traces.
            One run can span several traces.
          </p>
          <dl className="flex min-w-0 flex-col gap-1 break-all">
            <dt>Bot instance</dt>
            <dd>
              <code>{run.botId}</code>
            </dd>
            {run.sessionId && (
              <>
                <dt>Pi session</dt>
                <dd>
                  <code>{run.sessionId}</code>
                </dd>
              </>
            )}
          </dl>
          <a
            href={tracesUrl}
            target="_blank"
            rel="noreferrer"
            data-slot="button"
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            <ArrowUpRight /> Open Cloudflare traces
          </a>
        </CollapsibleContent>
      </Collapsible>
      <ol
        className="flex min-w-0 flex-col divide-y"
        aria-label="Durable run records"
      >
        {page.events.map((event) => (
          <li key={event.key} className="min-w-0 py-3">
            <RunEventView event={event} />
          </li>
        ))}
      </ol>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex flex-wrap gap-2">
        {older && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void clear()}
          >
            Latest records
          </Button>
        )}
        {page.next && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void earlier()}
          >
            {busy ? "Loading…" : "Earlier records"}
          </Button>
        )}
      </div>
    </section>
  )
}

export function RunEventView({ event }: { event: RunEvent }) {
  const attempt = event.attempt
  return (
    <div className="flex min-w-0 flex-col gap-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-medium">{event.title}</span>
        <Badge variant="outline">{event.status}</Badge>
      </div>
      <time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
      {attempt && (
        <>
          <p>
            {attempt.purpose} ·{" "}
            {attempt.outcome === "interrupted"
              ? "Duration unknown after restart"
              : attempt.finishedAt
                ? elapsed(attempt.startedAt, attempt.finishedAt)
                : "In progress"}
          </p>
          <p className="text-muted-foreground">
            {attempt.input === null
              ? "Usage unreported"
              : `${attempt.input.toLocaleString()} input · ${attempt.cached?.toLocaleString() ?? "unknown"} cached · ${attempt.output?.toLocaleString() ?? "unknown"} output`}
          </p>
        </>
      )}
      {event.detail && <p className="text-muted-foreground">{event.detail}</p>}
      {event.kind === "tool" && (
        <div className="flex flex-col gap-1 text-muted-foreground">
          {!event.transitions?.length && <p>Transition timing not recorded.</p>}
          {event.transitions?.map((transition, index, all) => {
            const next = all[index + 1]
            const label =
              transition.status === "pending"
                ? "Waiting for approval"
                : transition.status === "approved"
                  ? "Ready to dispatch"
                  : transition.status === "running"
                    ? "Dispatch to saved result"
                    : transition.status
            return (
              <p key={index}>
                {label}
                {next
                  ? ` · ${transition.status === "running" && next.status !== "done" ? "duration unknown" : elapsed(transition.at, next.at)}`
                  : ""}
              </p>
            )
          })}
        </div>
      )}
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <code className="min-w-0 break-all">{event.reference}</code>
        <CopyButton
          text={event.reference}
          label={`Copy ${event.kind === "model" ? "model request" : event.kind === "tool" ? "tool operation" : "record"} ID`}
        />
      </div>
    </div>
  )
}
