import { useState } from "react"
import { Code2, Play, Square, RefreshCw } from "lucide-react"
import { useExecution } from "./use-execution"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function ExecutionWorkbench({
  agentId,
  agentName,
  selected,
  onSelect,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  agentId: string
  agentName: string
}) {
  const execution = useExecution(agentId, selected, onSelect)
  const [code, setCode] = useState(
    "console.log('Items:', input.length)\nreturn input.reduce((sum, n) => sum + n, 0)"
  )
  const [data, setData] = useState("[1, 2, 3]")
  const active = execution.runs.find((run) => run.status === "running")
  const run = execution.detail
  const content = (
    <>
      <header className="workbench-heading-row">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Code2 className="size-4" /> Code{" "}
          <Badge variant="secondary">JavaScript</Badge>
        </div>
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
      <div className="workbench-body">
        {execution.error && (
          <Alert>
            <AlertDescription>{execution.error}</AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">
          Run calculations and transform JSON in a private sandbox. No network,
          files or app credentials. 1 second of CPU, 10 seconds elapsed.
        </p>
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
              onChange={(event) => setCode(event.target.value)}
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
              onChange={(event) => setData(event.target.value)}
              maxLength={32768}
              disabled={execution.busy || !!execution.attempt}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Use <code>input</code> for parsed JSON, <code>console.log</code> for
            notes, and <code>return</code> for the result.
          </p>
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={
                execution.busy ||
                (!execution.attempt && !!active) ||
                !code.trim()
              }
            >
              <Play />
              {execution.attempt ? "Retry same request" : "Run code"}
            </Button>
            {active && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={execution.busy}
                onClick={() => void execution.cancel(active.id)}
              >
                <Square /> Cancel run
              </Button>
            )}
          </div>
          {execution.attempt && !execution.busy && (
            <p className="text-xs text-muted-foreground">
              The outcome is not confirmed. Retry sends the same saved request
              ID and cannot create a second run.
            </p>
          )}
        </form>
        {execution.selected && !run && (
          <p className="text-sm text-muted-foreground">Loading run…</p>
        )}
        {run && (
          <section
            aria-label="Run output"
            className="min-w-0 space-y-3 border-t pt-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Result</h3>
              <Badge variant="secondary">{run.status}</Badge>
            </div>
            {run.status === "running" && (
              <p className="text-sm text-muted-foreground">
                Running… You can close this panel; the result will be saved.
              </p>
            )}
            {run.status === "interrupted" && (
              <p className="text-sm">
                This run was interrupted. It has not been repeated. Review its
                code before starting a new run.
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
          </section>
        )}
        <section
          className="space-y-2 border-t pt-4"
          aria-label="Code run history"
        >
          <h3 className="text-sm font-medium">Recent runs</h3>
          {!execution.runs.length && (
            <p className="text-xs text-muted-foreground">
              Your bot’s runs will appear here.
            </p>
          )}
          {execution.runs.map((item) => (
            <Button
              key={item.id}
              className="h-auto w-full justify-between gap-3 py-2 text-left"
              size="sm"
              variant={execution.selected === item.id ? "secondary" : "ghost"}
              disabled={execution.busy}
              onClick={() => execution.select(item.id)}
            >
              <span className="min-w-0 truncate font-mono text-xs">
                {item.label}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.status}
              </span>
            </Button>
          ))}
        </section>
      </div>
      <footer className="border-t px-4 py-3 text-xs text-muted-foreground">
        Private to {agentName}. Code, input and results are saved. Latest 50
        runs shown.
      </footer>
    </>
  )
  return content
}
