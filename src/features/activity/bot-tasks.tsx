import { useEffect, useState } from "react"
import { Schema } from "effect"
import { ArrowRight, RotateCw, Square } from "lucide-react"
import { MailboxView, terminal, type Task } from "@/communication/contracts"
import type { ActivityAgent } from "@/activity/contracts"
import { agentApi } from "@/http/client"
import { poll } from "@/http/poll"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import { ActivityRecord } from "./activity-record"

export function BotTasks({
  agentId,
  agents,
  onOpenBot,
}: {
  agentId: ActivityAgent["id"]
  agents: readonly ActivityAgent[]
  onOpenBot: (id: ActivityAgent["id"]) => void
}) {
  const [state, setState] = useState<MailboxView | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState<string | null>(null),
    [retry, setRetry] = useState(0)
  const [origin, setOrigin] = useState<Task | null>(null)
  useEffect(() => {
    setState(null)
    setOrigin(null)
  }, [agentId])
  useEffect(() => {
    let alive = true
    const controller = new AbortController()
    setError("")
    const stop = poll(
      async () => {
        if (document.visibilityState !== "visible") return
        try {
          const value = Schema.decodeUnknownSync(MailboxView)(
            await agentApi(agentId)(
              "communication",
              undefined,
              controller.signal
            )
          )
          if (alive) {
            setState(value)
            setError("")
          }
        } catch (cause) {
          if (alive)
            setError(
              cause instanceof Error
                ? cause.message
                : "Bot tasks could not reconnect."
            )
        }
      },
      3000,
      true
    )
    return () => {
      alive = false
      controller.abort()
      stop()
    }
  }, [agentId, retry])
  async function control(id: string, action: "cancel" | "retry") {
    setPending(id)
    setError("")
    try {
      await agentApi(agentId)("communication/control", { id, action })
      setRetry((value) => value + 1)
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The update could not be confirmed. Retrying this control is safe."
      )
    } finally {
      setPending(null)
    }
  }
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
      {error && (
        <Alert>
          <AlertTitle>Updates interrupted</AlertTitle>
          <AlertDescription>
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setRetry((n) => n + 1)}
            >
              Reconnect
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!state && !error && <Skeleton className="h-24 w-full" />}
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
                        disabled={pending !== null}
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
                      disabled={pending !== null}
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
            key: origin.id,
            at: new Date(origin.request.createdAt).toISOString(),
            agent: { id: origin.request.from, name: name(origin.request.from) },
            kind: "conversation",
            title: "Original request",
            status: origin.status,
            attention: false,
            running: false,
            target: "conversation",
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
