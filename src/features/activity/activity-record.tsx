import { RunTimeline } from "./run-timeline"
import { Separator } from "@/components/ui/separator"
import type { RecoveryView } from "@/conversations/recovery"
import { useEffect, useState } from "react"
import { Schema } from "effect"
import { ActivityConversation, type ActivityEntry } from "@/activity/contracts"
import { agentApi } from "@/http/client"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { poll } from "@/http/poll"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

/** Read-only history. Inline object renderers stay in the owning bot's live workspace. */
export function ActivityRecord({
  entry,
  onClose,
  onOpenBot,
}: {
  entry: ActivityEntry
  onClose: () => void
  onOpenBot: () => void
}) {
  const [record, setRecord] = useState<ActivityConversation | null>(null),
    [error, setError] = useState("")
  useEffect(() => {
    setRecord(null)
    setError("")
    let current = true
    const controller = new AbortController()
    let settled = false
    const stop = poll(
      async () => {
        if (settled || document.visibilityState !== "visible") return
        try {
          const value = await agentApi(entry.agent.id)(
            `activity/conversations/${encodeURIComponent(entry.reference)}`,
            undefined,
            controller.signal
          )
          if (current) {
            const next = Schema.decodeUnknownSync(ActivityConversation)(value)
            setRecord(next)
            setError("")
            settled = ["done", "failed", "cancelled"].includes(next.status)
          }
        } catch (cause) {
          if (current)
            setError(
              cause instanceof Error
                ? cause.message
                : "This conversation is unavailable."
            )
        }
      },
      3000,
      true
    )
    return () => {
      current = false
      controller.abort()
      stop()
    }
  }, [entry.agent.id, entry.reference])
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="flex max-h-[85dvh] flex-col overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{entry.agent.name} · Saved activity</DialogTitle>
          <DialogDescription>
            Original conversation and committed tool results. Open the agent to
            approve, stop or retry current work.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <Alert>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {!record && !error && <Skeleton className="h-32 w-full" />}
        {record && (
          <div className="flex min-w-0 flex-col gap-4 wrap-anywhere">
            {record.run && (
              <>
                <RunTimeline
                  key={record.run.runId}
                  run={record.run}
                  agentId={entry.agent.id}
                />
                <Separator />
              </>
            )}
            <p className="text-xs text-muted-foreground">{record.status}</p>
            <div className="rounded-lg bg-muted p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {record.source === "background"
                  ? "Background report"
                  : "Original request"}
              </p>
              <Markdown text={record.text} />
            </div>
            <RecoveryNotice recovery={record.recovery} status={record.status} />
            {record.error && record.error !== record.recovery?.detail && (
              <Alert>
                <AlertDescription>{record.error}</AlertDescription>
              </Alert>
            )}
            {record.activity
              .filter((item) => item.type !== "text")
              .map((item) =>
                item.type === "steer" ? (
                  <div key={item.id} className="rounded-lg bg-muted p-3">
                    <p className="mb-2 text-xs text-muted-foreground">
                      Steering
                    </p>
                    <Markdown text={item.text} />
                    {item.attachments?.map((file) => (
                      <p
                        key={file.id}
                        className="text-xs text-muted-foreground"
                      >
                        Attachment: {file.name}
                      </p>
                    ))}
                  </div>
                ) : item.type === "thinking" ? (
                  <details key={item.id} className="rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      Thinking
                    </summary>
                    <Markdown text={item.text} />
                  </details>
                ) : (
                  <details key={item.id} className="rounded-lg border p-3">
                    <summary className="cursor-pointer text-sm font-medium">
                      {item.name} · {item.status}
                    </summary>
                    <div className="mt-3 flex flex-col gap-3 text-xs">
                      <p>Input</p>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
                        {item.input}
                      </pre>
                      <p>Saved result</p>
                      <pre className="max-h-72 overflow-auto whitespace-pre-wrap">
                        {item.output || "No terminal result has been saved."}
                      </pre>
                    </div>
                  </details>
                )
              )}
            {!!record.answer && <Markdown text={record.answer} />}
          </div>
        )}
        <Button variant="outline" onClick={onOpenBot}>
          Open {entry.agent.name}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

/** Execution progress and blockers, never a claim that the user's goal is complete. */
export function RecoveryNotice({
  recovery,
  status,
}: {
  recovery?: RecoveryView | null
  status: string
}) {
  if (!recovery || ["stopping", "cancelled"].includes(status)) return null
  const ended =
    ["done", "failed"].includes(status) && recovery.phase === "recovering"
  return (
    <Alert className="min-w-0 wrap-anywhere">
      <AlertTitle>
        {ended
          ? "Reply ended with tool failures"
          : recovery.phase === "blocked"
            ? "Work needs attention"
            : recovery.phase === "recovered"
              ? "Tool recovery made progress"
              : "Trying to recover"}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        <p>
          {ended
            ? "The reply ended before a successful tool recovery was recorded. See the saved answer and results."
            : recovery.detail}
        </p>
        <p className="text-xs">
          {recovery.tool}
          {recovery.reason === "repetition" &&
            ` · ${recovery.failures} matching failures`}
          {recovery.phase === "recovering" &&
            !ended &&
            ` · ${recovery.remaining} recovery attempts left`}
        </p>
        <p className="text-xs text-muted-foreground">
          Saved result {recovery.resultId}
          {recovery.receiptId && ` · Receipt ${recovery.receiptId}`}
        </p>
      </AlertDescription>
    </Alert>
  )
}
