import { useEffect, useState } from "react"
import { TerminalSquare, Play, Square, X, RefreshCw } from "lucide-react"
import { useTerminal } from "./use-terminal"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"

export function TerminalWorkbench({
  agentId,
  agentName,
  onClose,
}: {
  agentId: string
  agentName: string
  onClose: () => void
}) {
  const terminal = useTerminal(agentId)
  const [wide, setWide] = useState(false)
  const [command, setCommand] = useState(
    'printf "Hello from Linux\\n"\nls -la /workspace'
  )
  useEffect(() => {
    const media = window.matchMedia("(min-width: 1280px)")
    const update = () => setWide(media.matches)
    update()
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])
  const active = terminal.runs.find((run) => run.status === "running")
  const detail = terminal.detail
  const content = (
    <>
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          <TerminalSquare className="size-4" /> Terminal{" "}
          <Badge variant="secondary">Linux commands</Badge>
        </div>
        <div className="flex gap-1">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh terminal"
            disabled={terminal.busy}
            onClick={() => void terminal.refresh()}
          >
            <RefreshCw />
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Hide terminal"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-4">
        {terminal.cleanupError && (
          <Alert>
            <AlertDescription>
              {terminal.cleanupError}
              <Button
                size="sm"
                variant="outline"
                disabled={terminal.runtimeBusy}
                onClick={() => void terminal.cleanup()}
              >
                Retry cleanup
              </Button>
            </AlertDescription>
          </Alert>
        )}
        {terminal.error && (
          <Alert>
            <AlertDescription>{terminal.error}</AlertDescription>
          </Alert>
        )}
        <p className="text-xs text-muted-foreground">
          A private Linux workspace for this bot. Run shell commands with Node,
          Python and local files. Outbound networking is disabled.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void terminal.start(command)
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="terminal-command">Shell command</FieldLabel>
              <Textarea
                id="terminal-command"
                className="min-h-32 font-mono text-xs"
                spellCheck={false}
                maxLength={16000}
                value={terminal.attempt?.command ?? command}
                onChange={(event) => setCommand(event.target.value)}
                disabled={terminal.busy || !!terminal.attempt}
              />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                size="sm"
                disabled={
                  terminal.busy ||
                  (!terminal.attempt &&
                    (terminal.runtimeBusy || !!terminal.cleanupError)) ||
                  !command.trim()
                }
              >
                <Play data-icon="inline-start" />
                {terminal.attempt ? "Retry same request" : "Run command"}
              </Button>
              {active && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={terminal.busy}
                  onClick={() => void terminal.cancel(active.id)}
                >
                  <Square data-icon="inline-start" />
                  Stop command
                </Button>
              )}
            </div>
            {terminal.runtimeBusy && !active && (
              <p className="text-xs text-muted-foreground">
                Cleaning up the previous container…
              </p>
            )}
            {terminal.attempt && !terminal.busy && (
              <p className="text-xs text-muted-foreground">
                The outcome is unconfirmed. Retry keeps the same command ID and
                cannot start a second run.
              </p>
            )}
          </FieldGroup>
        </form>
        {terminal.selected && !detail && (
          <p className="text-sm text-muted-foreground">Loading command…</p>
        )}
        {detail && (
          <section
            aria-label="Command output"
            className="flex min-w-0 flex-col gap-3 border-t pt-4"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium">Output</h3>
              <Badge variant="secondary">
                {detail.status}
                {detail.exitCode !== null ? ` · exit ${detail.exitCode}` : ""}
              </Badge>
            </div>
            {detail.status === "running" && (
              <p className="text-xs text-muted-foreground">
                Running… You can close this panel; output and status are saved.
              </p>
            )}
            {detail.error && (
              <Alert>
                <AlertDescription>{detail.error}</AlertDescription>
              </Alert>
            )}
            <pre className="max-h-80 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs break-words whitespace-pre-wrap">
              {detail.output || "No output yet."}
            </pre>
            <details>
              <summary className="cursor-pointer text-xs font-medium">
                Executed command
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">
                {detail.command}
              </pre>
            </details>
          </section>
        )}
        <section
          aria-label="Workspace recovery"
          className="flex flex-col gap-2 border-t pt-4"
        >
          <h3 className="text-sm font-medium">Saved workspace</h3>
          <p className="text-xs text-muted-foreground">
            {terminal.savedAt
              ? `Last saved ${new Date(terminal.savedAt).toLocaleString()}.`
              : "Your first completed command will create a checkpoint."}
          </p>
          <p className="text-xs text-muted-foreground">
            Only /workspace is restored between commands. Checkpoints exclude
            node_modules, .git and .cache. Stop or a failed save returns to the
            previous checkpoint. Background processes end with each command.
          </p>
        </section>
        <section
          aria-label="Command history"
          className="flex flex-col gap-2 border-t pt-4"
        >
          <h3 className="text-sm font-medium">Recent commands</h3>
          {!terminal.runs.length && (
            <p className="text-xs text-muted-foreground">
              Your bot’s commands will appear here.
            </p>
          )}
          {terminal.runs.map((item) => (
            <Button
              key={item.id}
              className="h-auto w-full justify-between gap-3 py-2 text-left"
              size="sm"
              variant={terminal.selected === item.id ? "secondary" : "ghost"}
              disabled={terminal.busy}
              onClick={() => terminal.select(item.id)}
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
        Private to {agentName}. 30 seconds per command, 64,000 output
        characters, 8 MiB compressed checkpoint. Latest 20 commands shown.
      </footer>
    </>
  )
  return wide ? (
    <aside
      className="browser-workbench flex min-h-0 w-[480px] shrink-0 flex-col border-l bg-background"
      aria-label={`${agentName} terminal`}
    >
      {content}
    </aside>
  ) : (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <SheetContent
        className="gap-0 p-0 data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        showCloseButton={false}
      >
        <SheetHeader className="sr-only">
          <SheetTitle>{agentName} terminal</SheetTitle>
          <SheetDescription>
            Run Linux commands and inspect this bot's saved workspace.
          </SheetDescription>
        </SheetHeader>
        {content}
      </SheetContent>
    </Sheet>
  )
}
