import "./execution.css"
import { Link } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import {
  CardFrame,
  Card,
  CardContent,
  CardFrameFooter,
} from "@workspace/ui/components/card"
import { Field, FieldLabel } from "@workspace/ui/components/field"
import { Textarea } from "@workspace/ui/components/textarea"
import { Code2, Play, Square, RefreshCw } from "lucide-react"
import { useEffect, useState } from "react"

import { parseAgentId, workspaceDestination } from "@/navigation/workspace"

import { useExecution } from "./use-execution"

export function ExecutionWorkbench({
  onPendingChange,
  agentId,
  selected,
  onSelect,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentId: string
  onPendingChange: (pending: boolean) => void
}) {
  const execution = useExecution(agentId, selected, onSelect)
  const pending = execution.busy || !!execution.attempt
  useEffect(() => {
    onPendingChange(pending)
    return () => onPendingChange(false)
  }, [pending, onPendingChange])
  const [code, setCode] = useState(
    "console.log('Items:', input.length)\nreturn input.reduce((sum, n) => sum + n, 0)"
  )
  const [data, setData] = useState("[1, 2, 3]")
  const run = execution.detail
  const content = (
    <section className="execution-workbench @container/tool flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4 @max-md/tool:px-4">
        <h2 className="flex min-w-0 items-center gap-2 text-md font-semibold">
          <Code2 className="size-4" /> Code{" "}
          <Badge variant="secondary">JavaScript</Badge>
        </h2>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh code runs"
            disabled={execution.busy}
            onClick={() => void execution.refresh()}
          >
            <RefreshCw />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 @max-md/tool:p-4">
        {execution.error && (
          <Alert>
            <AlertDescription>{execution.error}</AlertDescription>
          </Alert>
        )}
        <ExecutionEditor
          execution={execution}
          code={code}
          data={data}
          onCodeChange={setCode}
          onDataChange={setData}
        />
        {execution.selected && !run && (
          <p className="text-sm text-muted-foreground">Loading run…</p>
        )}
        {run && (
          <CardFrame aria-label="Run output" className="execution-result">
            <Card>
              <CardContent className="flex flex-col gap-3 p-4">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">Result</h3>
                  <Badge variant="secondary">
                    {run.status === "succeeded" ? "Completed" : run.status}
                  </Badge>
                </div>
                {run.status === "running" && (
                  <p className="text-sm text-muted-foreground">
                    Running… You can close this panel; the result will be saved.
                  </p>
                )}
                {run.status === "interrupted" && (
                  <p className="text-sm">
                    This run was interrupted. It has not been repeated. Review
                    its code before starting a new run.
                  </p>
                )}
                {run.status === "cancelled" && (
                  <p className="text-sm text-muted-foreground">
                    Run cancelled. Late output will not replace this result.
                  </p>
                )}
                {run.output?.error && (
                  <Alert>
                    <AlertDescription>{run.output.error}</AlertDescription>
                  </Alert>
                )}
                {run.output?.result && (
                  <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-3 text-xs break-words whitespace-pre-wrap">
                    {run.output.result}
                  </pre>
                )}
              </CardContent>
            </Card>
            <CardFrameFooter className="flex-col items-stretch gap-3">
              {run.output?.logs && (
                <details>
                  <summary className="cursor-pointer text-xs font-medium">
                    Console output
                  </summary>
                  <pre className="mt-2 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">
                    {run.output.logs}
                  </pre>
                </details>
              )}
              <details>
                <summary className="cursor-pointer text-xs font-medium">
                  Executed code and input
                </summary>
                <pre className="mt-2 max-h-60 overflow-auto text-xs break-words whitespace-pre-wrap">
                  {run.input.code}
                  {"\n\nInput: "}
                  {run.input.data}
                </pre>
              </details>
            </CardFrameFooter>
          </CardFrame>
        )}
        <section
          className="flex flex-col gap-2 border-t pt-4"
          aria-label="Code run history"
        >
          <h3 className="text-sm font-medium">Recent runs</h3>
          {!execution.runs.length && (
            <p className="text-xs text-muted-foreground">
              Run code above to see the result here.
            </p>
          )}
          {execution.runs.map((item) => (
            <Link
              key={item.id}
              {...workspaceDestination(parseAgentId(agentId), {
                panel: "code",
                item: item.id,
              })}
              aria-current={execution.selected === item.id ? "page" : undefined}
              title={item.label}
              className={buttonVariants({
                size: "sm",
                variant: execution.selected === item.id ? "secondary" : "ghost",
                className: "h-auto w-full justify-between gap-3 py-2 text-left",
              })}
              disabled={pending}
            >
              <span className="min-w-0 truncate font-mono text-xs">
                {item.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.status === "succeeded" ? "Completed" : item.status}
              </span>
            </Link>
          ))}
        </section>
      </div>
      <footer className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer">
            Sandbox limits &amp; storage
          </summary>
          <p className="mt-2 max-w-prose leading-relaxed">
            Private JavaScript sandbox. No network, files or app credentials. 1
            second of CPU, 10 seconds elapsed. Code, input and results are
            saved; the latest 50 runs are shown.
          </p>
        </details>
      </footer>
    </section>
  )
  return content
}

function ExecutionEditor({
  execution,
  code,
  data,
  onCodeChange,
  onDataChange,
}: {
  execution: ReturnType<typeof useExecution>
  code: string
  data: string
  onCodeChange: (value: string) => void
  onDataChange: (value: string) => void
}) {
  const active = execution.runs.find((run) => run.status === "running")
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void execution.start(code, data)
      }}
    >
      <Field>
        <FieldLabel htmlFor="execution-code">JavaScript</FieldLabel>
        <Textarea
          id="execution-code"
          className="min-h-40 font-mono text-xs"
          spellCheck={false}
          value={execution.attempt?.code ?? code}
          onChange={(event) => onCodeChange(event.target.value)}
          maxLength={16384}
          disabled={execution.busy || !!execution.attempt}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="execution-data">Input JSON</FieldLabel>
        <Textarea
          id="execution-data"
          className="min-h-16 font-mono text-xs"
          spellCheck={false}
          value={execution.attempt?.data ?? data}
          onChange={(event) => onDataChange(event.target.value)}
          maxLength={32768}
          disabled={execution.busy || !!execution.attempt}
        />
      </Field>
      <p className="text-xs text-muted-foreground">
        Use <code>input</code> for parsed JSON and <code>return</code> for the
        result.
      </p>
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={
            execution.busy || (!execution.attempt && !!active) || !code.trim()
          }
        >
          <Play />
          {execution.attempt ? "Retry same request" : "Run code"}
        </Button>
        {(active || execution.attempt) && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={execution.busy}
            onClick={() =>
              void execution.cancel(execution.attempt?.id ?? active!.id)
            }
          >
            <Square /> {execution.attempt ? "Cancel request" : "Cancel run"}
          </Button>
        )}
      </div>
      {execution.attempt && !execution.busy && (
        <p className="text-xs text-muted-foreground">
          The outcome is not confirmed. Retry sends the same saved request ID
          and cannot create a second run.
        </p>
      )}
    </form>
  )
}
