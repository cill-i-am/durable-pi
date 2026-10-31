import {
  Alert,
  AlertTitle,
  AlertDescription,
} from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@workspace/ui/components/empty"
import { Separator } from "@workspace/ui/components/separator"
import { Schema } from "effect"
import { ArrowRight, RotateCw, Square } from "lucide-react"
import { useEffect, useState } from "react"

import type { ActivityAgent } from "@/activity/contracts"
import { MailboxView, terminal, type Task } from "@/communication/contracts"
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible"

import { ActivityRecord } from "./activity-record"
import { activityJsonRequest } from "./query-owner"
import { useActivityQuery } from "./use-activity-query"
import { useMailboxControl } from "./use-mailbox-control"

export function BotTasks({
  agentId,
  agents,
  onOpenBot,
}: {
  agentId: ActivityAgent["id"]
  agents: readonly ActivityAgent[]
  onOpenBot: (id: ActivityAgent["id"]) => void
}) {
  const query = useActivityQuery({
    key: JSON.stringify([agentId, "communication"]),
    interval: 3000,
    read: async (signal) =>
      Schema.decodeUnknownSync(MailboxView)(
        await activityJsonRequest(agentId, "communication", signal)
      ),
    errorMessage: "Bot tasks could not reconnect.",
  })
  const state = query.data
  const controls = useMailboxControl(agentId, state, query.refresh)
  const pending = controls.pending
  const error = controls.error || query.error
  const control = controls.submit
  const [origin, setOrigin] = useState<Task | null>(null)
  useEffect(() => setOrigin(null), [agentId])
  const recovery = state?.recovery
  const name = (id: string) =>
    agents.find((a) => a.id === id)?.name ?? "Archived bot"
  return (
    <section
      className="flex min-w-0 flex-col gap-3"
      aria-label="Bot communication"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Bot tasks</h3>
        <Badge variant="outline">Text-only · private</Badge>
      </div>
      <p className="text-xs text-muted-foreground">
        Recent requests between your bots. Accepted means saved; completed means
        a result is available. No files or action permissions are shared.
      </p>
      {recovery && (
        <Alert>
          <AlertTitle>Mailbox needs attention</AlertTitle>
          <AlertDescription>
            {recovery.message}
            <Button
              variant="outline"
              size="sm"
              disabled={controls.blocked(recovery.epoch, "retry_mailbox")}
              aria-busy={pending === recovery.epoch}
              onClick={() => void control(recovery.epoch, "retry_mailbox")}
            >
              <RotateCw data-icon="inline-start" />
              Retry mailbox
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert>
          <AlertTitle>Updates interrupted</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => void query.refresh()}
            >
              Reconnect
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!state && !error && <DataLoading loading label="Loading bot tasks" />}
      {state && !state.tasks.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No bot tasks yet</EmptyTitle>
            <EmptyDescription>
              Ask this agent to consult one of your other bots. You can inspect
              and stop its requests here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {state?.tasks.map((task) => {
        const payload = task.request.payload
        const deliveries = state.deliveries.filter(
          (d) => d.envelope.taskId === task.id
        )
        const accepted = deliveries.find(
          (d) => d.envelope.id === task.request.id
        )
        return (
          <Collapsible key={task.id} className="flex min-w-0 flex-col gap-2">
            <CollapsibleTrigger className="flex min-w-0 flex-col gap-2 rounded-md p-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">
              <span className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                {name(task.request.from)}
                <ArrowRight className="size-3" />
                {name(task.request.to)}
              </span>
              <span className="text-sm wrap-anywhere">
                {payload.kind === "task" || payload.kind === "question"
                  ? payload.objective
                  : "Bot task"}
              </span>
              <span className="flex flex-wrap gap-2">
                <Badge variant="secondary">
                  {task.status.replaceAll("_", " ")}
                </Badge>
                <Badge variant="outline">
                  Delivery:{" "}
                  {accepted?.status ??
                    (task.direction === "incoming" ? "accepted" : "pending")}
                </Badge>
              </span>
            </CollapsibleTrigger>
            <CollapsibleContent className="flex min-w-0 flex-col gap-3 px-2 pb-3 text-sm wrap-anywhere">
              {task.status === "cancelling" && (
                <p className="text-muted-foreground">
                  Cancellation requested. Waiting for the recipient to confirm
                  termination.
                </p>
              )}
              {task.outcome && (
                <div className="flex flex-col gap-1">
                  <strong>
                    {task.status === "awaiting_input"
                      ? "Needs input"
                      : "Result"}
                  </strong>
                  <p className="whitespace-pre-wrap">{task.outcome.text}</p>
                </div>
              )}
              {task.direction === "outgoing" &&
                terminal(task) &&
                !task.resumed &&
                task.control.unconfirmed && (
                  <Alert>
                    <AlertTitle>Result not confirmed</AlertTitle>
                    <AlertDescription>
                      The result is saved, but returning it to this bot could
                      not be confirmed. Retrying uses the saved result and
                      original task.
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={controls.blocked(task.id, "retry")}
                        aria-busy={pending === task.id}
                        onClick={() => void control(task.id, "retry")}
                      >
                        <RotateCw data-icon="inline-start" />
                        Retry result
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
              {(payload.kind === "task" || payload.kind === "question") &&
                payload.context && (
                  <details>
                    <summary className="cursor-pointer text-muted-foreground">
                      Supplied context
                    </summary>
                    <p className="mt-2 whitespace-pre-wrap">
                      {payload.context}
                    </p>
                  </details>
                )}
              <p className="text-xs text-muted-foreground">
                Deadline {new Date(task.request.deadline).toLocaleString()}.
                Retrying delivery preserves the task identity and does not start
                the task again.
              </p>
              {deliveries.map((delivery) => (
                <div key={delivery.envelope.id} className="flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">
                    {delivery.envelope.payload.kind} delivery ·{" "}
                    {delivery.status} · {delivery.attempts} attempts
                  </span>
                  {delivery.error && <p>{delivery.error}</p>}
                  {delivery.status === "failed" &&
                    delivery.envelope.deadline > Date.now() &&
                    ((delivery.envelope.payload.kind !== "task" &&
                      delivery.envelope.payload.kind !== "question") ||
                      (!terminal(task) && !task.cancelRequested)) && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={controls.blocked(
                          delivery.envelope.id,
                          "retry"
                        )}
                        onClick={() =>
                          void control(delivery.envelope.id, "retry")
                        }
                      >
                        <RotateCw data-icon="inline-start" />
                        Retry delivery
                      </Button>
                    )}
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setOrigin(task)}
                >
                  Original request
                </Button>
                {task.direction === "outgoing" &&
                  !terminal(task) &&
                  !task.cancelRequested && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={controls.blocked(task.id, "cancel")}
                      onClick={() => void control(task.id, "cancel")}
                    >
                      <Square data-icon="inline-start" />
                      Request cancellation
                    </Button>
                  )}
              </div>
            </CollapsibleContent>
            <Separator />
          </Collapsible>
        )
      })}
      {origin && (
        <ActivityRecord
          entry={{
            agent: { id: origin.request.from, name: name(origin.request.from) },
            reference: origin.request.correlationId,
          }}
          onClose={() => setOrigin(null)}
          onOpenBot={() => {
            onOpenBot(origin.request.from)
            setOrigin(null)
          }}
        />
      )}
    </section>
  )
}
