import { ActivityTimeline } from "./activity-timeline"
import type { ActivityAgent } from "@/activity/contracts"
import { DelegatedWork } from "./delegated-work"
import { InferenceRuns } from "./inference-runs"
import { useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronDown,
  Circle,
  Clock3,
} from "lucide-react"
import { Schema } from "effect"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { PlanDetail, type Plan, type PlanRevision } from "@/planning/contracts"
import { agentApi } from "@/http/client"
import { usePlans } from "./use-plans"
import { historyPage } from "./history"

export function ActivityWorkbench({
  agentId: initialId,
  agentName: initialName,
  agents,
  onOpenBot,
  onMemory,
}: {
  agentId: ActivityAgent["id"]
  agentName: ActivityAgent["name"]
  agents: readonly ActivityAgent[]
  onOpenBot: (id: ActivityAgent["id"]) => void
  onMemory: (id: ActivityAgent["id"]) => void
}) {
  const [showTimeline, setShowTimeline] = useState(true)
  const [{ id: agentId, name: agentName }, setInspectedAgent] = useState({
    id: initialId,
    name: initialName,
  })
  const [selected, setSelected] = useState<string | null>(null),
    [offset, setOffset] = useState(0)
  const state = usePlans(agentId, selected, offset, !showTimeline)
  return (
    <>
      <div className="workbench-body">
        <div className="flex items-center justify-between gap-3">
          <h2 className="workbench-title">Activity</h2>
          {!showTimeline && (
            <Badge variant="outline" className="max-w-[50%] min-w-0 shrink">
              <span className="truncate">{agentName}</span>
            </Badge>
          )}
        </div>
        {showTimeline ? (
          <ActivityTimeline
            agent={
              agents.find((value) => value.id === initialId) ?? {
                id: initialId,
                name: initialName,
              }
            }
            agents={agents}
            onOpenBot={onOpenBot}
            onMemory={onMemory}
            onDetails={(agent) => {
              setInspectedAgent(agent)
              setSelected(null)
              setOffset(0)
              setShowTimeline(false)
            }}
          />
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="self-start"
              onClick={() => setShowTimeline(true)}
            >
              <ArrowLeft /> Activity timeline
            </Button>
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
                <p className="text-sm text-muted-foreground">
                  The work, the next step, and what needs your attention.
                </p>
                {state.loading && <Skeleton className="h-24 w-full" />}
                {!state.loading && !state.list.plans.length && (
                  <Empty>
                    <EmptyHeader>
                      <EmptyTitle>No task plans yet</EmptyTitle>
                      <EmptyDescription>
                        Ask your agent for help with a project. It will keep
                        track of substantial work here. Simple chat stays
                        simple.
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
        )}
      </div>
    </>
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
        <h3 className="text-lg font-semibold">{plan.objective}</h3>
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
      <ol className="flex flex-col gap-3">
        {plan.steps.map((step) => (
          <li key={step.id} className="flex flex-col gap-2 border-b pb-4">
            <div className="flex items-start gap-3">
              {step.status === "completed" ? (
                <Check className="mt-1 size-4 shrink-0 text-primary" />
              ) : (
                <Circle className="mt-1 size-4 shrink-0 text-muted-foreground" />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <p className="text-sm font-medium">{step.title}</p>
                <span className="text-xs text-muted-foreground">
                  {step.status === "completed"
                    ? "Agent-reported completion"
                    : step.status}
                </span>
              </div>
            </div>
            {step.note && (
              <p className="pl-7 text-sm text-muted-foreground">{step.note}</p>
            )}
            {!!step.evidence.length && (
              <Collapsible>
                <CollapsibleTrigger
                  render={<Button variant="ghost" size="sm" />}
                >
                  <ChevronDown data-icon="inline-start" />{" "}
                  {step.evidence.length} evidence{" "}
                  {step.evidence.length === 1 ? "reference" : "references"}
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="flex flex-col gap-3 pt-2 pl-7">
                    {step.evidence.map((ref, index) => (
                      <li key={index} className="flex flex-col gap-1 text-xs">
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
                          <span className="text-muted-foreground">
                            {ref.kind} · revision {ref.revision}
                          </span>
                        </div>
                        <code className="break-all">{ref.id}</code>
                        <p className="text-muted-foreground">{ref.detail}</p>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}
          </li>
        ))}
      </ol>
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
  const [older, setOlder] = useState<PlanRevision[]>([])
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  const { history, cursor } = historyPage(detail.history, older)
  async function earlier() {
    if (busy || cursor === null) return
    setBusy(true)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(PlanDetail)(
        await agentApi(agentId)(`plans/${detail.plan.id}?before=${cursor}`)
      )
      setOlder((values) => [...values, ...result.history])
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "History could not load."
      )
    } finally {
      setBusy(false)
    }
  }
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
