import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Separator } from "@workspace/ui/components/separator"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { Schema } from "effect"
import { Brain, Wrench } from "lucide-react"

import { ActivityConversation, type ActivityEntry } from "@/activity/contracts"
import { CopyButton } from "@/components/copy-button"
import { Markdown } from "@/components/markdown"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockContent,
} from "@/components/ui/code-block"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
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
import type { RecoveryView } from "@/conversations/recovery"

import { activityJsonRequest } from "./query-owner"
import { RunTimeline } from "./run-timeline"
import { useActivityQuery } from "./use-activity-query"

export function ActivityRecord({
  entry,
  onClose,
  onOpenBot,
  active = true,
}: {
  active?: boolean
  entry: Pick<ActivityEntry, "agent" | "reference">
  onClose: () => void
  onOpenBot: () => void
}) {
  const {
    data: record,
    error,
    refresh,
  } = useActivityQuery({
    key: JSON.stringify(["record", entry.agent.id, entry.reference]),
    interval: 3000,
    read: async (signal) =>
      Schema.decodeUnknownSync(ActivityConversation)(
        await activityJsonRequest(
          entry.agent.id,
          `activity/conversations/${encodeURIComponent(entry.reference)}`,
          signal
        )
      ),
    terminal: (value) => ["done", "failed", "cancelled"].includes(value.status),
    errorMessage: "This conversation is unavailable.",
  })
  return (
    <Dialog
      open={active}
      onOpenChange={(open) => {
        if (active && !open) onClose()
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
            <AlertDescription>
              {error}
              <Button
                variant="outline"
                size="sm"
                onClick={() => void refresh()}
              >
                Reconnect
              </Button>
            </AlertDescription>
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
            <Trace role="group" aria-label="Saved agent activity">
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
                    <TraceCollapsible key={item.id}>
                      <TraceCollapsibleTrigger>
                        <TraceLine>
                          <TraceIcon>
                            <Brain />
                          </TraceIcon>
                          <TraceTitle>Thought</TraceTitle>
                        </TraceLine>
                      </TraceCollapsibleTrigger>
                      <TraceCollapsibleContent keepMounted>
                        <Markdown text={item.text} />
                      </TraceCollapsibleContent>
                    </TraceCollapsible>
                  ) : (
                    <TraceCollapsible key={item.id}>
                      <TraceCollapsibleTrigger>
                        <TraceLine
                          status={
                            item.status === "error" ||
                            item.status === "interrupted"
                              ? "error"
                              : undefined
                          }
                        >
                          <TraceIcon>
                            <Wrench />
                          </TraceIcon>
                          <TraceTitle>{item.name}</TraceTitle>
                          <TraceDescription>{item.status}</TraceDescription>
                        </TraceLine>
                      </TraceCollapsibleTrigger>
                      <TraceCollapsibleContent
                        keepMounted
                        className="flex flex-col gap-3"
                      >
                        <CodeBlock size="sm">
                          <CodeBlockHeader>
                            <CodeBlockTitle>Input</CodeBlockTitle>
                            <CodeBlockActions>
                              <CopyButton
                                text={item.input}
                                label="Copy saved tool input"
                              />
                            </CodeBlockActions>
                          </CodeBlockHeader>
                          <CodeBlockContent wrap className="max-h-48">
                            {item.input}
                          </CodeBlockContent>
                        </CodeBlock>
                        <CodeBlock size="sm">
                          <CodeBlockHeader>
                            <CodeBlockTitle>Saved result</CodeBlockTitle>
                            <CodeBlockActions>
                              <CopyButton
                                text={item.output}
                                label="Copy saved tool result"
                              />
                            </CodeBlockActions>
                          </CodeBlockHeader>
                          <CodeBlockContent wrap className="max-h-72">
                            {item.output ||
                              "No terminal result has been saved."}
                          </CodeBlockContent>
                        </CodeBlock>
                      </TraceCollapsibleContent>
                    </TraceCollapsible>
                  )
                )}
            </Trace>
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
