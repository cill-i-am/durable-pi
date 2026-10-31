import "./activity.css"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Separator } from "@workspace/ui/components/separator"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Schema } from "effect"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  Clock3,
  ListChecks,
} from "lucide-react"

import type { ActivityAgent } from "@/activity/contracts"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
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
import type { WorkspaceQuery } from "@/navigation/workspace"
import { PlanDetail, type Plan, type PlanRevision } from "@/planning/contracts"

import { ActivityTimeline } from "./activity-timeline"
import { BotTasks } from "./bot-tasks"
import { DelegatedWork } from "./delegated-work"
import { historyPage } from "./history"
import { InferenceRuns } from "./inference-runs"
import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"
import { usePlans } from "./use-plans"

export function ActivityWorkbench({
  agentId: initialId,
  agentName: initialName,
  agents,
  onOpenBot,
  onMemory,
  view,
  inspectedAgentId,
  selected,
  onSelectionChange,
  filters,
  onFiltersChange,
  offset,
  onOffsetChange: setOffset,
  active = true,
}: {
  active?: boolean
  filters: Pick<WorkspaceQuery, "scope" | "filter" | "cursor">
  onFiltersChange: (
    value: Pick<WorkspaceQuery, "scope" | "filter" | "cursor">
  ) => void
  offset: number
  onOffsetChange: (value: number) => void
  view: "timeline" | "tasks"
  inspectedAgentId: ActivityAgent["id"]
  selected: string | null
  onSelectionChange: (
    view: "timeline" | "tasks",
    agentId: ActivityAgent["id"],
    selected: string | null
  ) => void
  agentId: ActivityAgent["id"]
  agentName: ActivityAgent["name"]
  agents: readonly ActivityAgent[]
  onOpenBot: (id: ActivityAgent["id"]) => void
  onMemory: (id: ActivityAgent["id"]) => void
}) {
  const showTimeline = view === "timeline"
  const inspected = agents.find((value) => value.id === inspectedAgentId)
  const agentId = inspectedAgentId
  const agentName = inspected?.name ?? "Unavailable agent"
  const setSelected = (id: string | null) =>
    onSelectionChange("tasks", agentId, id)
  const state = usePlans(
    agentId,
    selected,
    offset,
    !showTimeline && !!inspected
  )
  if (!inspected)
    return (
      <Alert>
        <AlertDescription>
          This assistant is unavailable.
          <Button variant="link" size="sm" onClick={() => onOpenBot(initialId)}>
            Return to your assistant
          </Button>
        </AlertDescription>
      </Alert>
    )
  return (
    <div className="activity-workbench @container/tool flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 @max-md/tool:p-4">
      {!showTimeline && (
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-md font-semibold">Activity</h2>
          <Badge variant="outline" className="max-w-[50%] min-w-0 shrink">
            <span className="truncate">{agentName}</span>
          </Badge>
        </div>
      )}
      {showTimeline ? (
        <ActivityTimeline
          active={active}
          filters={filters}
          onFiltersChange={onFiltersChange}
          agent={
            agents.find((value) => value.id === initialId) ?? {
              id: initialId,
              name: initialName,
            }
          }
          agents={agents}
          onOpenBot={onOpenBot}
          onMemory={onMemory}
          record={selected ? { agent: inspected, reference: selected } : null}
          onRecordChange={(record) =>
            onSelectionChange(
              "timeline",
              record?.agent.id ?? agentId,
              record?.reference ?? null
            )
          }
          onDetails={(agent) => {
            onSelectionChange("tasks", agent.id, null)
          }}
        />
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => onSelectionChange("timeline", initialId, null)}
          >
            <ArrowLeft /> Activity timeline
          </Button>
          {!selected && (
            <BotTasks
              onOpenBot={onOpenBot}
              key={`${agentId}:communication`}
              agentId={agentId}
              agents={agents}
            />
          )}
          {!selected && <DelegatedWork key={agentId} agentId={agentId} />}
          {!selected && (
            <DelegatedWork
              key={`${agentId}:background`}
              agentId={agentId}
              background
            />
          )}
          {!selected && <InferenceRuns agentId={agentId} />}
          {state.error && (
            <Alert>
              <AlertTitle>Updates interrupted</AlertTitle>
              <AlertDescription>
                {state.error}
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void state.refresh()}
                >
                  Reconnect
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {!!state.approvals.length && (
            <Alert>
              <Clock3 />
              <AlertTitle>Needs your approval</AlertTitle>
              <AlertDescription>
                {state.approvals.length} tool{" "}
                {state.approvals.length === 1 ? "request is" : "requests are"}{" "}
                waiting. The plan grants no additional access.
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onOpenBot(agentId)}
                >
                  Review in chat
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <PlanBrowser
            selected={selected}
            setSelected={setSelected}
            state={state}
            agentId={agentId}
            offset={offset}
            setOffset={setOffset}
          />
        </>
      )}
    </div>
  )
}

export function PlanView({ plan }: { plan: Plan }) {
  const completed = plan.steps.filter(
    (step) => step.status === "completed"
  ).length
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {plan.state === "completed"
              ? "Reported complete"
              : plan.state === "cancelled"
                ? "Cancelled"
                : "Open task"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {completed} of {plan.steps.length} steps · Revision {plan.revision}
          </span>
        </div>
        <h3 className="text-md font-semibold wrap-anywhere">
          {plan.objective}
        </h3>
      </div>
      {plan.blocker && (
        <Alert>
          <Clock3 />
          <AlertTitle>
            {plan.state === "cancelled" ? "Work stopped" : "Waiting on"}
          </AlertTitle>
          <AlertDescription>{plan.blocker}</AlertDescription>
        </Alert>
      )}
      {!!plan.constraints.length && (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Keep in mind</h4>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
            {plan.constraints.map((constraint, i) => (
              <li key={i}>{constraint}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="flex flex-col gap-2">
        <h4 className="text-sm font-medium">Done when</h4>
        <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
          {plan.criteria.map((criterion, i) => (
            <li key={i}>{criterion}</li>
          ))}
        </ul>
      </section>
      <Trace>
        <TraceCollapsible defaultOpen>
          <TraceCollapsibleTrigger>
            <TraceLine>
              <TraceIcon>
                <ListChecks />
              </TraceIcon>
              <TraceTitle>Plan</TraceTitle>
              <TraceDescription>
                {completed} of {plan.steps.length} done
              </TraceDescription>
            </TraceLine>
          </TraceCollapsibleTrigger>
          <TraceCollapsibleContent keepMounted>
            <Trace role="group" aria-label="Plan steps">
              {plan.steps.map((step) => (
                <TraceCollapsible
                  key={step.id}
                  defaultOpen={
                    step.status === "active" || step.status === "blocked"
                  }
                >
                  <TraceCollapsibleTrigger>
                    <TraceLine
                      className="flex-wrap"
                      status={
                        plan.state === "cancelled"
                          ? undefined
                          : step.status === "blocked"
                            ? "error"
                            : step.status === "active" &&
                                plan.state === "open" &&
                                !plan.blocker
                              ? "running"
                              : step.status === "pending"
                                ? "pending"
                                : undefined
                      }
                    >
                      <TraceIcon>
                        {step.status === "completed" ? (
                          <Check />
                        ) : step.status === "blocked" ? (
                          <Clock3 />
                        ) : (
                          <Circle />
                        )}
                      </TraceIcon>
                      <TraceTitle title={step.title}>{step.title}</TraceTitle>
                      <TraceDescription>
                        {step.status === "completed"
                          ? "Reported done"
                          : plan.state === "cancelled"
                            ? "Stopped"
                            : step.status}
                      </TraceDescription>
                    </TraceLine>
                  </TraceCollapsibleTrigger>
                  <TraceCollapsibleContent
                    keepMounted
                    className="flex flex-col gap-3"
                  >
                    {step.status === "completed" && (
                      <p className="text-xs">Agent-reported completion</p>
                    )}
                    {step.note && <p className="text-sm">{step.note}</p>}
                    {!!step.evidence.length && (
                      <Trace>
                        <TraceCollapsible>
                          <TraceCollapsibleTrigger>
                            <TraceLine>
                              <TraceTitle>
                                {step.evidence.length} evidence{" "}
                                {step.evidence.length === 1
                                  ? "reference"
                                  : "references"}
                              </TraceTitle>
                            </TraceLine>
                          </TraceCollapsibleTrigger>
                          <TraceCollapsibleContent keepMounted>
                            <ul className="flex flex-col gap-3">
                              {step.evidence.map((ref, index) => (
                                <li
                                  key={index}
                                  className="flex flex-col gap-1 text-xs"
                                >
                                  <div className="flex flex-wrap gap-2">
                                    <Badge
                                      variant={
                                        ref.state === "valid"
                                          ? "secondary"
                                          : "destructive"
                                      }
                                    >
                                      {ref.state === "valid"
                                        ? "Source validated"
                                        : "No longer current"}
                                    </Badge>
                                    <span>
                                      {ref.kind} · revision {ref.revision}
                                    </span>
                                  </div>
                                  <code className="break-all">{ref.id}</code>
                                  <p>{ref.detail}</p>
                                </li>
                              ))}
                            </ul>
                          </TraceCollapsibleContent>
                        </TraceCollapsible>
                      </Trace>
                    )}
                  </TraceCollapsibleContent>
                </TraceCollapsible>
              ))}
            </Trace>
          </TraceCollapsibleContent>
        </TraceCollapsible>
      </Trace>
      {plan.nextAction && plan.state !== "cancelled" && (
        <section className="flex flex-col gap-2">
          <h4 className="text-sm font-medium">Next action</h4>
          <p className="text-sm text-muted-foreground">{plan.nextAction}</p>
        </section>
      )}
    </div>
  )
}
function PlanInspector({
  agentId,
  detail,
}: {
  agentId: string
  detail: PlanDetail
}) {
  const {
    data: older,
    busy,
    error,
    refresh,
  } = useActivityQuery<readonly PlanRevision[], number>({
    key: JSON.stringify(["plan-history", agentId, detail.plan.id]),
    auto: false,
    read: async (signal, cursor) => {
      const result = Schema.decodeUnknownSync(PlanDetail)(
        await activityJsonRequest(
          agentId,
          `plans/${detail.plan.id}?before=${cursor}`,
          signal
        )
      )
      if (
        result.plan.id !== detail.plan.id ||
        result.history.some((entry) => entry.plan.id !== detail.plan.id)
      )
        throw new Error("History does not match this plan.")
      return result.history
    },
    merge: (previous, result) => [...(previous ?? []), ...result],
    errorMessage: "History could not load.",
  })
  const { history, cursor } = historyPage(detail.history, older ?? [])
  const earlier = () => (cursor !== null ? refresh(cursor) : Promise.resolve())
  return (
    <>
      <PlanView plan={detail.plan} />
      <Separator />
      <Collapsible>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
          <ChevronDown data-icon="inline-start" /> Revision history
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-4 pt-3">
          {history.map((entry) => (
            <Collapsible key={entry.plan.revision}>
              <CollapsibleTrigger
                render={
                  <Button
                    variant="outline"
                    className="h-auto w-full justify-start py-3 text-left whitespace-normal"
                  />
                }
              >
                <span className="flex flex-col gap-1">
                  <span>
                    Revision {entry.plan.revision} · {entry.actor}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {entry.reason}
                  </span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="py-4">
                <p className="mb-3 text-xs text-muted-foreground">
                  Historical snapshot · {entry.plan.updatedAt}
                </p>
                <PlanView plan={entry.plan} />
              </CollapsibleContent>
            </Collapsible>
          ))}
          {error && (
            <Alert>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {cursor !== null && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => void earlier()}
            >
              {busy ? "Loading…" : "Earlier revisions"}
            </Button>
          )}
        </CollapsibleContent>
      </Collapsible>
    </>
  )
}

function PlanBrowser({
  selected,
  setSelected,
  state,
  agentId,
  offset,
  setOffset,
}: {
  selected: string | null
  setSelected: (value: string | null) => void
  state: ReturnType<typeof usePlans>
  agentId: ActivityAgent["id"]
  offset: number
  setOffset: (value: number) => void
}) {
  return (
    <>
      {" "}
      {selected ? (
        <>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            onClick={() => setSelected(null)}
          >
            <ArrowLeft data-icon="inline-start" /> All tasks
          </Button>
          {state.detail ? (
            <PlanInspector
              key={selected}
              agentId={agentId}
              detail={state.detail}
            />
          ) : state.loading ? (
            <Skeleton className="h-32 w-full" />
          ) : null}
        </>
      ) : (
        <>
          {state.loading && <Skeleton className="h-24 w-full" />}
          {!state.loading && !state.list.plans.length && (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>No task plans yet</EmptyTitle>
                <EmptyDescription>
                  Ask your agent for help with a project. It will keep track of
                  substantial work here.
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {state.list.plans.map((plan) => (
            <div key={plan.id} className="flex flex-col gap-3">
              <Button
                variant="ghost"
                className="h-auto w-full justify-start py-3 text-left whitespace-normal"
                onClick={() => setSelected(plan.id)}
              >
                <span className="flex min-w-0 flex-1 flex-col gap-2">
                  <span>{plan.objective}</span>
                  <span className="text-xs text-muted-foreground">
                    {plan.completed} of {plan.total} steps ·{" "}
                    {plan.state === "open"
                      ? "Open task"
                      : plan.state === "completed"
                        ? "Reported complete"
                        : "Cancelled"}
                  </span>
                </span>
                <ArrowRight data-icon="inline-end" />
              </Button>
              {plan.blocker && (
                <p className="px-3 text-sm text-muted-foreground">
                  {plan.blocker}
                </p>
              )}
              <Separator />
            </div>
          ))}
          <div className="flex items-center justify-between">
            {offset > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                Newer tasks
              </Button>
            ) : (
              <span />
            )}
            {state.list.nextOffset !== null && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setOffset(state.list.nextOffset!)}
              >
                Earlier tasks
              </Button>
            )}
          </div>
        </>
      )}
    </>
  )
}
