import { Schema } from "effect"
import { MessageCircle } from "lucide-react"
import { useCallback, useEffect, useId, useRef, useState } from "react"

import type { AgentProfile } from "@/agents/contracts"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { agentApi, ApiError } from "@/http/client"
import { poll } from "@/http/poll"
import { replyProgressText, replyRetryLabel } from "@/replies/progress"
import {
  WhatsAppView,
  type ConfigureWhatsApp,
  type RetryWhatsApp,
} from "@/whatsapp/contracts"

const labels = {
  queued: "Queued",
  waiting: "Agent is working",
  sending: "Sending reply",
  sent: "Accepted by WhatsApp",
  failed: "Send rejected",
  uncertain: "Delivery unconfirmed",
  cancelled: "Cancelled",
  expired: "Reply window closed",
}
// An unconfirmed mutation must replay its original URL target and operation ID.
type Change = { agentId: string } & (
  | { path: "configure"; body: ConfigureWhatsApp }
  | { path: "retry"; body: typeof RetryWhatsApp.Type }
)
export function WhatsAppSettings({
  agents,
  open,
  onPendingChange,
}: {
  agents: readonly AgentProfile[]
  open: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const [view, setView] = useState<WhatsAppView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Change | null>(null)
  const [resend, setResend] = useState<string | null>(null)
  const [chosenAgentId, setChosenAgentId] = useState<string | null>(null)
  const activeAgents = agents.filter((agent) => agent.status === "active")
  const selectedAgentId =
    chosenAgentId ??
    (view && activeAgents.some((agent) => agent.id === view.agentId)
      ? view.agentId
      : null)
  const routingDirty =
    !!view && selectedAgentId !== null && selectedAgentId !== view.agentId
  const lock = useRef(false),
    sequence = useRef(0)
  const refresh = useCallback(async () => {
    if (lock.current || attempt) return
    const generation = ++sequence.current
    try {
      const result = Schema.decodeUnknownSync(WhatsAppView)(
        await agentApi("home")("whatsapp")
      )
      if (generation === sequence.current) {
        setView(result)
        setError("")
      }
    } catch (cause) {
      if (generation === sequence.current)
        setError(
          cause instanceof Error ? cause.message : "Could not load WhatsApp."
        )
    }
  }, [attempt])
  useEffect(() => {
    if (!open) return
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      5000,
      true
    )
    return () => {
      stop()
      // oxlint-disable-next-line react/exhaustive-deps -- Invalidate pending responses, not a DOM node.
      sequence.current++
    }
  }, [open, refresh])
  useEffect(() => {
    onPendingChange(busy || !!attempt || !!resend || routingDirty)
  }, [busy, attempt, resend, routingDirty, onPendingChange])
  async function change(input: Change) {
    if (lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    setAttempt(input)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(WhatsAppView)(
        await agentApi(input.agentId)(`whatsapp/${input.path}`, input.body)
      )
      setView(result)
      setAttempt(null)
      if (input.path === "configure") setChosenAgentId(null)
    } catch (cause) {
      if (cause instanceof ApiError && [400, 409].includes(cause.status))
        setAttempt(null)
      setError(
        cause instanceof Error
          ? cause.message
          : "The change was not confirmed. Retry the same request."
      )
    } finally {
      lock.current = false
      setBusy(false)
    }
  }
  const retry = (id: string, acknowledgeDuplicateRisk: boolean) =>
    change({
      agentId: "home",
      path: "retry",
      body: { id, acknowledgeDuplicateRisk, operationId: crypto.randomUUID() },
    })
  const configure = (enabled: boolean) => {
    if (!view) return
    const agentId = enabled ? selectedAgentId : view.agentId
    if (
      !agentId ||
      (enabled && !activeAgents.some((agent) => agent.id === agentId))
    )
      return
    return change({
      agentId,
      path: "configure",
      body: {
        enabled,
        revision: view.revision,
        operationId: crypto.randomUUID(),
      },
    })
  }
  return (
    <section aria-label="WhatsApp connection" className="flex flex-col gap-4">
      <WhatsAppRouting
        view={view}
        agents={activeAgents}
        selectedAgentId={selectedAgentId}
        onAgentChange={setChosenAgentId}
        onCancelRouting={() => setChosenAgentId(null)}
        routingDirty={routingDirty}
        disabled={busy || !!attempt || !!resend}
        configure={configure}
      />
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {attempt && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => change(attempt)}
        >
          Retry same request
        </Button>
      )}
      {!attempt && error && (
        <Button variant="ghost" disabled={busy} onClick={refresh}>
          Reload WhatsApp
        </Button>
      )}
      {!!view?.messages.length && (
        <section
          aria-label="Recent WhatsApp replies"
          className="flex flex-col gap-3"
        >
          <h4 className="text-sm font-medium">Recent WhatsApp replies</h4>
          {view.messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {message.kind === "image"
                    ? "Image · "
                    : message.kind === "audio"
                      ? "Audio · "
                      : message.kind === "media"
                        ? "Attachment · "
                        : ""}
                  {message.preparingFiles
                    ? "Preparing files"
                    : labels[message.state]}
                </Badge>
                {["failed", "uncertain", "expired"].includes(message.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      !!attempt ||
                      !!resend ||
                      routingDirty ||
                      !view.enabled ||
                      !activeAgents.some(
                        (agent) => agent.id === message.agentId
                      )
                    }
                    onClick={() =>
                      message.state === "uncertain"
                        ? setResend(message.id)
                        : retry(message.id, false)
                    }
                  >
                    {replyRetryLabel(message.progress)}
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Agent:{" "}
                {agents.find((agent) => agent.id === message.agentId)?.name ??
                  (message.agentId === view.agentId
                    ? view.agentName
                    : message.agentId)}
              </p>
              <p className="text-xs text-muted-foreground">
                {new Date(message.createdAt).toLocaleString()}
              </p>
              {message.progress && (
                <p className="text-sm text-muted-foreground">
                  {replyProgressText(message.progress)}
                </p>
              )}
              {message.error && (
                <p className="text-sm text-muted-foreground">{message.error}</p>
              )}
            </div>
          ))}
        </section>
      )}
      <AlertDialog
        open={resend !== null}
        onOpenChange={(value) => {
          if (!value) setResend(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this WhatsApp reply again?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirmed messages will be skipped. The next unconfirmed message
              may have reached WhatsApp. Check it first. Sending again may
              create a duplicate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button
              onClick={async () => {
                const id = resend
                setResend(null)
                if (id) await retry(id, true)
              }}
            >
              Send again
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function WhatsAppRouting({
  view,
  agents,
  selectedAgentId,
  onAgentChange,
  onCancelRouting,
  routingDirty,
  disabled,
  configure,
}: {
  view: WhatsAppView | null
  agents: readonly AgentProfile[]
  selectedAgentId: string | null
  onAgentChange: (id: string) => void
  onCancelRouting: () => void
  routingDirty: boolean
  disabled: boolean
  configure: (enabled: boolean) => unknown
}) {
  const selectedAgent = agents.find((agent) => agent.id === selectedAgentId)
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">WhatsApp</h3>
      <p className="text-sm text-muted-foreground">
        {!view
          ? "Loading WhatsApp…"
          : view.configured
            ? "Send text from your connected WhatsApp account. Approvals stay in Pi and Executor."
            : "WhatsApp Business setup is pending. Once connected, choose which agent receives your messages."}
      </p>
      {view?.enabled && (
        <p className="text-sm">
          New WhatsApp messages go to {view.agentName}. Earlier requests keep
          their original agent.
        </p>
      )}
      <WhatsAppAgentSelect
        view={view}
        agents={agents}
        selectedAgent={selectedAgent}
        disabled={disabled}
        onAgentChange={onAgentChange}
      />
      <WhatsAppRoutingActions
        view={view}
        selectedAgent={selectedAgent}
        routingDirty={routingDirty}
        disabled={disabled}
        configure={configure}
        onCancelRouting={onCancelRouting}
      />
      {view?.enabled && (
        <p className="text-xs text-muted-foreground">
          Disabling stops new messages and replies that have not started
          sending. Use /agents and /agent &lt;id&gt; in WhatsApp to change
          agents.
        </p>
      )}
      {view?.enabled && view.contactUrl && (
        <a
          href={view.contactUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm underline underline-offset-4"
        >
          Open WhatsApp
        </a>
      )}
      <p className="text-xs text-muted-foreground">
        Replies need a WhatsApp message from you within the last 24 hours. Send
        files and review full answers in Pi.
      </p>
    </div>
  )
}

function WhatsAppAgentSelect({
  view,
  agents,
  selectedAgent,
  disabled,
  onAgentChange,
}: {
  view: WhatsAppView | null
  agents: readonly AgentProfile[]
  selectedAgent: AgentProfile | undefined
  disabled: boolean
  onAgentChange: (id: string) => void
}) {
  const selectionId = useId()
  return (
    <>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={selectionId}>WhatsApp agent</FieldLabel>
          <Select
            items={agents.map((agent) => ({
              value: agent.id,
              label: agent.name,
            }))}
            value={selectedAgent?.id ?? null}
            disabled={!view || disabled || agents.length === 0}
            onValueChange={(value) => {
              if (value) onAgentChange(value)
            }}
          >
            <SelectTrigger id={selectionId} className="w-full">
              <SelectValue placeholder="Choose an agent" />
            </SelectTrigger>
            <SelectContent mobileTitle="WhatsApp agent">
              <SelectGroup>
                {agents.map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </Field>
      </FieldGroup>
      {view && !agents.some((agent) => agent.id === view.agentId) && (
        <p className="text-sm text-muted-foreground">
          {view.agentName} is unavailable. Choose an active agent to route new
          WhatsApp messages.
        </p>
      )}
      {view && agents.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Create or restore an agent before enabling WhatsApp.
        </p>
      )}
    </>
  )
}

function WhatsAppRoutingActions({
  view,
  selectedAgent,
  routingDirty,
  disabled,
  configure,
  onCancelRouting,
}: {
  view: WhatsAppView | null
  selectedAgent: AgentProfile | undefined
  routingDirty: boolean
  disabled: boolean
  configure: (enabled: boolean) => unknown
  onCancelRouting: () => void
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={
          !view?.configured ||
          disabled ||
          !selectedAgent ||
          (view.enabled && view.agentId === selectedAgent.id)
        }
        onClick={() => configure(true)}
      >
        <MessageCircle data-icon="inline-start" />
        {view?.enabled ? "Save WhatsApp agent" : "Enable WhatsApp"}
      </Button>
      {routingDirty && (
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled}
          onClick={onCancelRouting}
        >
          Cancel
        </Button>
      )}
      {view?.enabled && (
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || routingDirty}
          onClick={() => configure(false)}
        >
          Disable WhatsApp
        </Button>
      )}
    </div>
  )
}
