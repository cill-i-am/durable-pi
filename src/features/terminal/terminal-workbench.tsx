import { Link } from "@tanstack/react-router"

import "./terminal.css"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button, buttonVariants } from "@workspace/ui/components/button"
import { DataLoading } from "@workspace/ui/components/data-loading"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldContent,
  FieldDescription,
} from "@workspace/ui/components/field"
import { Switch } from "@workspace/ui/components/switch"
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@workspace/ui/components/tabs"
import { Textarea } from "@workspace/ui/components/textarea"
import { Play, Square, RefreshCw, Settings2, X } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { useReloadGuard } from "@/features/updates/update-recovery"
import { parseAgentId, workspaceDestination } from "@/navigation/workspace"
import type { TerminalNetworkPolicy } from "@/terminal/contracts"

import { FileTransfers, ExportedFile } from "./file-transfers"
import { InteractiveTerminal } from "./interactive-terminal"
import { useTerminal } from "./use-terminal"

/** Agent identity also owns local drafts, selection observers and export hosts. */
export function TerminalWorkbench(
  props: Parameters<typeof TerminalWorkbenchView>[0]
) {
  return <TerminalWorkbenchView key={props.agentId} {...props} />
}

function TerminalWorkbenchView({
  onPendingChange,
  agentId,
  selected,
  onSelect,
  tab,
  onTabChange,
  active = true,
}: {
  active?: boolean
  tab: "commands" | "interactive" | "transfers"
  onTabChange: (tab: "commands" | "interactive" | "transfers") => void
  selected: string | null
  onSelect: (id: string | null) => void
  agentId: string
  onPendingChange: (pending: boolean) => void
}) {
  const terminal = useTerminal(agentId, selected, onSelect)
  useReloadGuard(
    "Save and close, or discard the interactive terminal before reloading.",
    terminal.session !== null
  )
  const [networkSettings, setNetworkSettings] =
    useState<TerminalNetworkPolicy | null>(null)
  const settingsTrigger = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !networkSettings) settingsTrigger.current?.focus()
    wasEditing.current = !!networkSettings
  }, [networkSettings])
  const pending =
    terminal.busy ||
    !!terminal.attempt ||
    !!terminal.sessionAttempt ||
    !!terminal.transferAttempt
  useEffect(() => {
    onPendingChange(pending || !!networkSettings)
    return () => onPendingChange(false)
  }, [pending, networkSettings, onPendingChange])
  const [command, setCommand] = useState(
    'printf "Hello from Linux\\n"\nls -la /workspace'
  )
  const content = (
    <section className="terminal-workbench @container/tool flex min-h-0 min-w-0 flex-1 flex-col">
      <TerminalHeader
        terminal={terminal}
        networkSettings={networkSettings}
        setNetworkSettings={setNetworkSettings}
        settingsTrigger={settingsTrigger}
        pending={pending}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-5 @max-md/tool:p-4">
        {terminal.networkPolicy === null && (
          <p role="status" className="text-xs text-muted-foreground">
            This terminal service hasn’t provided its internet settings yet.
            Refresh to check again.
          </p>
        )}
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
        {!terminal.busy &&
          (terminal.attempt ||
            terminal.sessionAttempt ||
            terminal.transferAttempt) && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => void terminal.cancelPending()}
            >
              Cancel unconfirmed request
            </Button>
          )}
        {networkSettings && (
          <TerminalNetworkSettings
            terminal={terminal}
            networkSettings={networkSettings}
            setNetworkSettings={setNetworkSettings}
          />
        )}
        <div hidden={!!networkSettings} className="terminal-main">
          <div className="terminal-context">
            <span>/workspace</span>
            <span>{terminalInternetLabel(terminal.networkPolicy)}</span>
          </div>
          <Tabs
            value={tab}
            onValueChange={(value: unknown) => {
              if (
                value === "commands" ||
                value === "interactive" ||
                value === "transfers"
              )
                onTabChange(value)
            }}
          >
            <TabsList>
              <TabsTrigger disabled={pending} value="commands">
                Commands
              </TabsTrigger>
              <TabsTrigger disabled={pending} value="interactive">
                Interactive
              </TabsTrigger>
              <TabsTrigger disabled={pending} value="transfers">
                File transfer
              </TabsTrigger>
            </TabsList>
            <TabsContent value="transfers">
              <FileTransfers
                active={active}
                agentId={agentId}
                busy={
                  terminal.busy ||
                  (!terminal.transferAttempt &&
                    (terminal.runtimeBusy || !!terminal.cleanupError))
                }
                attempt={!!terminal.transferAttempt}
                onImport={(id) => void terminal.importFile(id)}
                onExport={(path) => void terminal.exportFile(path)}
                onRetry={() => void terminal.retryTransfer()}
                onCancel={() => void terminal.cancelTransfer()}
              />
            </TabsContent>
            <TabsContent value="interactive">
              <InteractiveTerminal
                agentId={agentId}
                session={terminal.session}
                lease={terminal.lease}
                busy={
                  terminal.busy ||
                  (!terminal.session &&
                    (terminal.runtimeBusy || !!terminal.cleanupError))
                }
                attempt={!!terminal.sessionAttempt}
                onStart={() => void terminal.openSession()}
                onSave={() => void terminal.saveSession()}
                onDiscard={() => {
                  if (terminal.session)
                    void terminal.cancel(terminal.session.id)
                }}
              />
            </TabsContent>
            <TabsContent value="commands">
              <CommandEditor
                terminal={terminal}
                command={command}
                setCommand={setCommand}
              />
            </TabsContent>
          </Tabs>
          <TerminalResult terminal={terminal} agentId={agentId} />
          <section
            aria-label="Workspace recovery"
            className="terminal-recovery"
          >
            <details>
              <summary>Saved workspace</summary>
              <p className="text-xs text-muted-foreground">
                {terminal.savedAt
                  ? `Last saved ${new Date(terminal.savedAt).toLocaleString()}.`
                  : "Your first completed command will create a checkpoint."}
              </p>
              <p className="text-xs text-muted-foreground">
                Only /workspace is restored between commands. Checkpoints
                exclude node_modules, .git and .cache. Stop or a failed save
                returns to the previous checkpoint. Background processes end
                with each command.
              </p>
            </details>
          </section>
          <CommandHistory
            terminal={terminal}
            agentId={agentId}
            pending={pending}
          />
        </div>
      </div>
      <footer className="shrink-0 border-t px-5 py-3 text-xs text-muted-foreground">
        <details>
          <summary className="cursor-pointer">Command limits</summary>
          <p className="mt-2 max-w-prose leading-relaxed">
            30 seconds per command, 64,000 output characters, 8 MiB compressed
            checkpoint. Latest 20 commands shown.
          </p>
        </details>
      </footer>
    </section>
  )
  return content
}

type TerminalState = ReturnType<typeof useTerminal>

function TerminalHeader({
  terminal,
  networkSettings,
  setNetworkSettings,
  settingsTrigger,
  pending,
}: {
  terminal: TerminalState
  networkSettings: TerminalNetworkPolicy | null
  setNetworkSettings: (value: TerminalNetworkPolicy | null) => void
  settingsTrigger: React.Ref<HTMLButtonElement>
  pending: boolean
}) {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-4 @max-md/tool:px-4">
      <h2 className="min-w-0 text-md font-semibold wrap-anywhere">
        {networkSettings ? "Terminal internet access" : "Terminal"}
      </h2>
      <div className="flex gap-1">
        <Button
          size="icon-sm"
          variant="ghost"
          ref={settingsTrigger}
          aria-label={
            networkSettings
              ? "Close terminal settings"
              : "Terminal internet settings"
          }
          disabled={pending || !terminal.networkPolicy}
          onClick={() => {
            if (terminal.networkPolicy)
              setNetworkSettings(
                networkSettings ? null : terminal.networkPolicy
              )
          }}
        >
          {networkSettings ? <X /> : <Settings2 />}
        </Button>
        {!networkSettings && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Refresh terminal"
            disabled={terminal.busy}
            onClick={() => void terminal.refresh()}
          >
            <RefreshCw />
          </Button>
        )}
      </div>
    </header>
  )
}

function TerminalNetworkSettings({
  terminal,
  networkSettings,
  setNetworkSettings,
}: {
  terminal: TerminalState
  networkSettings: TerminalNetworkPolicy
  setNetworkSettings: (value: TerminalNetworkPolicy | null) => void
}) {
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (await terminal.configureNetwork(networkSettings))
          setNetworkSettings(null)
      }}
    >
      <FieldGroup>
        <Field
          orientation="horizontal"
          data-disabled={terminal.busy || terminal.runtimeBusy}
        >
          <FieldContent>
            <FieldLabel htmlFor="terminal-internet">
              Unrestricted internet access
            </FieldLabel>
            <FieldDescription>
              Allow shell commands and the interactive terminal to reach the
              internet, including downloads and package installs. Tool
              permissions still apply; application and model credentials are not
              shared.
            </FieldDescription>
          </FieldContent>
          <Switch
            id="terminal-internet"
            checked={networkSettings.unrestricted}
            disabled={terminal.busy || terminal.runtimeBusy}
            onCheckedChange={(unrestricted) =>
              setNetworkSettings({ ...networkSettings, unrestricted })
            }
          />
        </Field>
        {terminal.runtimeBusy && (
          <p className="text-sm text-muted-foreground">
            Stop or save the active session and wait for cleanup before changing
            internet access.
          </p>
        )}
        {networkSettings.revision !== terminal.networkPolicy?.revision && (
          <p className="text-sm text-destructive">
            Settings changed elsewhere. Cancel and reopen settings to review
            them.
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={
              terminal.busy ||
              terminal.runtimeBusy ||
              !!terminal.cleanupError ||
              networkSettings.revision !== terminal.networkPolicy?.revision
            }
          >
            Save internet settings
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={terminal.busy}
            onClick={() => setNetworkSettings(null)}
          >
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

function CommandEditor({
  terminal,
  command,
  setCommand,
}: {
  terminal: TerminalState
  command: string
  setCommand: (command: string) => void
}) {
  const active = terminal.runs.find((run) => run.status === "running")
  return (
    <form
      className="terminal-run-form"
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
            className="terminal-command min-h-32 font-mono text-xs"
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
  )
}

function TerminalResult({
  terminal,
  agentId,
}: {
  terminal: TerminalState
  agentId: string
}) {
  const detail = terminal.detail
  return (
    <>
      {terminal.selected && !detail && (
        <DataLoading
          loading={!terminal.error}
          label="Loading command"
          layout="code"
        />
      )}
      {detail?.kind === "session" && detail.status !== "running" && (
        <Alert>
          <AlertDescription>
            {detail.status === "succeeded"
              ? "Workspace saved. The terminal is closed."
              : detail.status === "cancelled"
                ? "Session discarded. The previous workspace checkpoint is unchanged."
                : "Workspace was not saved. " +
                  (detail.error ??
                    "The terminal was interrupted; the previous checkpoint will be restored.")}
          </AlertDescription>
        </Alert>
      )}
      {detail && detail.kind !== "session" && (
        <CommandOutput detail={detail} agentId={agentId} />
      )}
    </>
  )
}

function terminalInternetLabel(policy: TerminalState["networkPolicy"]) {
  return policy?.unrestricted
    ? "Internet enabled"
    : policy
      ? "Internet off"
      : "Checking internet access…"
}

function CommandHistory({
  terminal,
  agentId,
  pending,
}: {
  terminal: TerminalState
  agentId: string
  pending: boolean
}) {
  return (
    <section
      aria-label="Command history"
      className="flex flex-col gap-2 border-t pt-4"
    >
      <h3 className="text-sm font-medium">Recent commands</h3>
      {!terminal.loaded && !terminal.error && (
        <DataLoading loading label="Loading terminal commands" />
      )}
      {terminal.loaded && !terminal.error && !terminal.runs.length && (
        <p className="text-xs text-muted-foreground">
          Run a command above to see it here.
        </p>
      )}
      {terminal.runs.map((item) => (
        <Link
          key={item.id}
          {...workspaceDestination(parseAgentId(agentId), {
            panel: "terminal",
            item: item.id,
          })}
          aria-current={terminal.selected === item.id ? "page" : undefined}
          title={item.label}
          className={buttonVariants({
            size: "sm",
            variant: terminal.selected === item.id ? "secondary" : "ghost",
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
  )
}

function CommandOutput({
  detail,
  agentId,
}: {
  detail: NonNullable<TerminalState["detail"]>
  agentId: string
}) {
  return (
    <section
      aria-label="Command output"
      className="flex min-w-0 flex-col gap-3 border-t pt-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">Output</h3>
        <Badge variant="secondary">
          {detail.status === "succeeded" ? "Completed" : detail.status}
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
      {detail.transfer && (
        <p className="text-xs break-all">{detail.transfer.path}</p>
      )}
      {detail.transfer?.kind === "import" && detail.status === "succeeded" && (
        <p className="text-xs text-muted-foreground">
          File copied and workspace saved.
        </p>
      )}
      <ExportedFile key={detail.id} agentId={agentId} run={detail} />
      {!detail.transfer && (
        <pre className="terminal-output">
          {detail.output || "No output yet."}
        </pre>
      )}
      <details>
        <summary className="cursor-pointer text-xs font-medium">
          Executed command
        </summary>
        <pre className="mt-2 max-h-40 overflow-auto text-xs break-words whitespace-pre-wrap">
          {detail.command}
        </pre>
      </details>
    </section>
  )
}
