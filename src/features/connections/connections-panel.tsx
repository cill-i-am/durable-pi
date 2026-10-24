import { ArrowUpRight, Plug, RefreshCw, X } from "lucide-react"
import { useEffect, useState } from "react"

import {
  executorDefaultTools,
  executorUrl,
  isExecutorConnection,
} from "@/access/executor"
import { SettingsSection } from "@/components/settings-section"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

import { useConnections } from "./use-connections"

const newDraft = () => ({
  id: `mcp-${crypto.randomUUID().replaceAll("-", "")}`,
  name: "",
  url: "",
})
const statusLabel = {
  disconnected: "Disconnected",
  connecting: "Connecting",
  authorization: "Sign-in needed",
  ready: "Connected",
  unavailable: "Unavailable",
}
export function ConnectionsPanel({
  callbackResult,
  onCallbackConsumed,
  embedded = false,
  onPendingChange,
  agentId,
  agentName,
  onManageLibrary,
  open,
  onOpenChange: setOpen,
  onSaved,
}: {
  callbackResult?: "connected" | "failed"
  onCallbackConsumed?: () => void
  embedded?: boolean
  onPendingChange?: (pending: boolean) => void
  agentId?: string
  agentName?: string
  onManageLibrary?: () => void
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const assignment = agentId !== undefined
  const state = useConnections(agentId, onSaved)
  const { refresh } = state
  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])
  const [draft, setDraft] = useState<ReturnType<typeof newDraft> | null>(null)
  const [callback, setCallback] = useState("")
  const disabled = state.busy || state.loading || !state.ready
  useEffect(() => {
    const result = callbackResult
    if (assignment || !result) return
    setCallback(
      result === "connected"
        ? "Authorization returned. Check the connection status below."
        : "Authorization did not finish. Reconnect to try again."
    )
    setOpen(true)
    void refresh()
    onCallbackConsumed?.()
  }, [assignment, callbackResult, onCallbackConsumed, refresh, setOpen])
  const notice = state.error || (!assignment && callback)
  const editing = !assignment && draft !== null
  useEffect(() => {
    onPendingChange?.(state.busy || editing)
  }, [state.busy, editing, onPendingChange])
  return (
    <SettingsSection
      embedded={embedded}
      open={open}
      onOpenChange={setOpen}
      title="Connections"
      description={
        assignment ? (
          <>Choose connected tools for {agentName ?? "this assistant"}.</>
        ) : (
          <>Manage your connected tools and services.</>
        )
      }
    >
      <div className="flex items-center justify-between gap-2 border-y px-4 py-2">
        <span className="text-sm text-muted-foreground">
          {assignment ? "Available tools" : "Your connections"}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={state.busy}
          onClick={() => void refresh()}
        >
          <RefreshCw data-icon="inline-start" />
          {state.loading ? "Loading…" : "Reload"}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4">
        {notice && (
          <Alert>
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        )}
        {assignment && onManageLibrary && (
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={onManageLibrary}
          >
            Manage connections
          </Button>
        )}
        {!assignment && (
          <ExecutorDefaults
            state={state}
            disabled={disabled}
            onConnect={() =>
              setDraft({ ...newDraft(), name: "Executor", url: executorUrl })
            }
          />
        )}
        {assignment && <SelectedTools state={state} disabled={disabled} />}
        <ConnectionCatalog
          state={state}
          disabled={disabled}
          assignment={assignment}
        />
        {!assignment && (
          <ConnectionForm
            state={state}
            disabled={disabled}
            draft={draft}
            setDraft={setDraft}
          />
        )}
      </div>
      <p className="border-t p-4 text-xs text-muted-foreground">
        {assignment
          ? "Executor tools are included automatically. New selections ask for approval before each call."
          : "Executor is included for every assistant. Choose other connected tools and their permissions in assistant settings."}{" "}
        Only the first 100 supported tools per connection are listed.
      </p>
    </SettingsSection>
  )
}

type ConnectionState = ReturnType<typeof useConnections>

function ExecutorDefaults({
  state,
  disabled,
  onConnect,
}: {
  state: ConnectionState
  disabled: boolean
  onConnect: () => void
}) {
  const defaults = executorDefaultTools(state.connections)
  return (
    <section className="flex flex-col gap-2" aria-label="Executor defaults">
      <h3 className="text-xs font-medium text-muted-foreground">
        Executor defaults
      </h3>
      <p className="text-sm text-muted-foreground">
        {defaults.length
          ? `${defaults.length} Executor tools are included automatically. Executor handles approvals in your browser. Choose per-tool restrictions in assistant settings.`
          : "Connect Executor once to make its tools available to every agent. Executor handles approvals in your browser."}
      </p>
      {!state.connections.some((connection) =>
        isExecutorConnection(connection.url)
      ) && (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={onConnect}
        >
          Connect Executor
        </Button>
      )}
    </section>
  )
}

function SelectedTools({
  state,
  disabled,
}: {
  state: ConnectionState
  disabled: boolean
}) {
  return (
    <section
      className="flex flex-col gap-2"
      aria-label="Selected connected tools"
    >
      <h3 className="text-xs font-medium text-muted-foreground">
        Selected tools · {state.selection.tools.length}/16
      </h3>
      {!state.selection.tools.length && (
        <p className="text-sm text-muted-foreground">
          No additional external tools selected. New selections ask for approval
          before each call.
        </p>
      )}
      {state.selection.tools.map((tool) => {
        const available = state.connections.some((connection) =>
          connection.tools.some((value) => value.name === tool.name)
        )
        return (
          <div
            key={tool.name}
            className="flex items-center gap-2 rounded-md border p-3"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm">{tool.remoteName}</p>
              <p className="truncate text-xs text-muted-foreground">
                {tool.connectionName}
                {available ? "" : " · unavailable or changed"}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${tool.remoteName} from this bot`}
              disabled={disabled}
              onClick={() =>
                void state.select(
                  state.selection.tools
                    .filter((value) => value.name !== tool.name)
                    .map((value) => value.name)
                )
              }
            >
              <X />
            </Button>
          </div>
        )
      })}
    </section>
  )
}

function ConnectionCatalog({
  state,
  disabled,
  assignment,
}: {
  state: ConnectionState
  disabled: boolean
  assignment: boolean
}) {
  const defaults = executorDefaultTools(state.connections)
  return (
    <section
      className="flex flex-col gap-4"
      aria-label={
        assignment ? "Available connected tools" : "Connection library"
      }
    >
      {state.connections.map((connection) => (
        <article
          key={connection.id}
          className="flex flex-col gap-3 rounded-lg border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="min-w-0 truncate font-medium">{connection.name}</h3>
            <Badge variant="secondary">{statusLabel[connection.status]}</Badge>
          </div>
          <p className="text-xs break-all text-muted-foreground">
            {connection.url}
          </p>
          {!assignment && (
            <>
              <div className="flex flex-wrap gap-2">
                {connection.authorizeUrl && (
                  <a
                    href={connection.authorizeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-slot="button"
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                    aria-disabled={disabled || undefined}
                    tabIndex={disabled ? -1 : undefined}
                    onClick={(event) => {
                      if (disabled) event.preventDefault()
                    }}
                  >
                    Sign in <ArrowUpRight data-icon="inline-end" />
                  </a>
                )}
                {connection.active && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void state.change(connection, "refresh")}
                  >
                    Refresh tools
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={disabled}
                  onClick={() => void state.change(connection, "reconnect")}
                >
                  Reconnect
                </Button>
                {connection.active && (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void state.change(connection, "disconnect")}
                  >
                    Disconnect
                  </Button>
                )}
              </div>
              {connection.active && (
                <p className="text-xs text-muted-foreground">
                  {isExecutorConnection(connection.url)
                    ? "Disconnect stops new calls for all agents. Executor defaults refresh after reconnection; actions already sent may finish."
                    : "Disconnect stops new calls for all bots. Reconnecting requires selecting tools again; actions already sent may finish."}
                </p>
              )}
            </>
          )}
          {!!connection.tools.length && (
            <details>
              <summary className="cursor-pointer text-sm">
                {assignment ? "Choose tools" : "Available tools"} ·{" "}
                {connection.tools.length}
              </summary>
              <div className="mt-3 flex flex-col gap-3">
                {connection.tools.map((tool) => {
                  const selected =
                    state.selection.tools.some(
                      (value) => value.name === tool.name
                    ) || defaults.some((value) => value.name === tool.name)
                  return (
                    <div
                      key={tool.name}
                      className="flex items-start gap-3 border-t pt-3"
                    >
                      <div className="min-w-0 flex-1">
                        <h4 className="text-sm font-medium break-words">
                          {tool.remoteName}
                        </h4>
                        <p className="line-clamp-3 text-xs break-words text-muted-foreground">
                          {tool.description}
                        </p>
                      </div>
                      {assignment && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={
                            disabled ||
                            selected ||
                            state.selection.tools.length >= 16
                          }
                          onClick={() =>
                            void state.select([
                              ...state.selection.tools.map(
                                (value) => value.name
                              ),
                              tool.name,
                            ])
                          }
                        >
                          {selected ? "Selected" : "Add"}
                        </Button>
                      )}
                    </div>
                  )
                })}
              </div>
            </details>
          )}
        </article>
      ))}
      {state.ready && !state.connections.length && (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Bring your tools</EmptyTitle>
            <EmptyDescription>
              {assignment
                ? "Add a connection to your library before choosing tools for this assistant."
                : "Add a public HTTPS MCP endpoint. Sign in with its provider if it requires authorization."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </section>
  )
}

function ConnectionForm({
  state,
  disabled,
  draft,
  setDraft,
}: {
  state: ConnectionState
  disabled: boolean
  draft: ReturnType<typeof newDraft> | null
  setDraft: (draft: ReturnType<typeof newDraft> | null) => void
}) {
  return draft ? (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (
          await state.add({
            ...draft,
            name: draft.name.trim(),
            url: draft.url.trim(),
          })
        )
          setDraft(null)
      }}
    >
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="connection-name">Connection name</FieldLabel>
          <Input
            id="connection-name"
            autoFocus
            required
            maxLength={80}
            value={draft.name}
            disabled={state.busy}
            onChange={(event) =>
              setDraft({ ...draft, name: event.target.value })
            }
            placeholder="My tools"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="connection-url">MCP endpoint</FieldLabel>
          <Input
            id="connection-url"
            type="url"
            required
            maxLength={2000}
            value={draft.url}
            disabled={state.busy}
            onChange={(event) =>
              setDraft({ ...draft, url: event.target.value })
            }
            placeholder="https://server.example.com/mcp"
          />
        </Field>
        <p className="text-xs text-muted-foreground">
          Use a server you trust. Do not paste tokens into the URL. Supports
          Streamable HTTP and public OAuth registration.
        </p>
        <div className="flex gap-2">
          <Button size="sm" disabled={disabled} type="submit">
            {state.busy ? "Connecting…" : "Connect server"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={state.busy}
            onClick={() => setDraft(null)}
          >
            Cancel
          </Button>
        </div>
      </FieldGroup>
    </form>
  ) : (
    <Button
      variant="outline"
      disabled={disabled || state.connections.length >= 20}
      onClick={() => setDraft(newDraft())}
    >
      <Plug data-icon="inline-start" />
      Add connection
    </Button>
  )
}
