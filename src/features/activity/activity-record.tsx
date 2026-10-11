import { useEffect, useState } from "react"
import { Schema } from "effect"
import { ActivityConversation, type ActivityEntry } from "@/activity/contracts"
import { agentApi } from "@/http/client"
import { Markdown } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
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
    void agentApi(entry.agent.id)(
      `activity/conversations/${encodeURIComponent(entry.reference)}`,
      undefined,
      controller.signal
    )
      .then((value) => {
        if (current)
          setRecord(Schema.decodeUnknownSync(ActivityConversation)(value))
      })
      .catch((cause) => {
        if (current)
          setError(
            cause instanceof Error
              ? cause.message
              : "This conversation is unavailable."
          )
      })
    return () => {
      current = false
      controller.abort()
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
            <p className="text-xs text-muted-foreground">{record.status}</p>
            <div className="rounded-lg bg-muted p-3">
              <p className="mb-2 text-xs text-muted-foreground">
                {record.source === "background"
                  ? "Background report"
                  : "Original request"}
              </p>
              <Markdown text={record.text} />
            </div>
            {record.error && (
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
