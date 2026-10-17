import { Schema } from "effect"
import { MessageCircle } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"

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
import { agentApi, ApiError } from "@/http/client"
import { poll } from "@/http/poll"
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
type Change =
  | { path: "configure"; body: ConfigureWhatsApp }
  | { path: "retry"; body: typeof RetryWhatsApp.Type }
export function WhatsAppSettings({
  agentId,
  agentName,
  archived,
  open,
  onPendingChange,
}: {
  agentId: string
  agentName: string
  archived: boolean
  open: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const [view, setView] = useState<WhatsAppView | null>(null)
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [attempt, setAttempt] = useState<Change | null>(null)
  const [resend, setResend] = useState<string | null>(null)
  const lock = useRef(false),
    sequence = useRef(0)
  const refresh = useCallback(async () => {
    if (lock.current) return
    const generation = ++sequence.current
    try {
      const result = Schema.decodeUnknownSync(WhatsAppView)(
        await agentApi(agentId)("whatsapp")
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
  }, [agentId])
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
    onPendingChange(busy || !!attempt || !!resend)
  }, [busy, attempt, resend, onPendingChange])
  async function change(input: Change) {
    if (lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    setAttempt(input)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(WhatsAppView)(
        await agentApi(agentId)(`whatsapp/${input.path}`, input.body)
      )
      setView(result)
      setAttempt(null)
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
      path: "retry",
      body: { id, acknowledgeDuplicateRisk, operationId: crypto.randomUUID() },
    })
  const configure = (enabled: boolean) =>
    view &&
    change({
      path: "configure",
      body: {
        enabled,
        revision: view.revision,
        operationId: crypto.randomUUID(),
      },
    })
  return (
    <section aria-label="WhatsApp connection" className="flex flex-col gap-4">
      <WhatsAppRouting
        view={view}
        agentId={agentId}
        agentName={agentName}
        archived={archived}
        disabled={busy || !!attempt}
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
      {!!view?.messages.some((message) => message.agentId === agentId) && (
        <section
          aria-label="Recent WhatsApp replies"
          className="flex flex-col gap-3"
        >
          <h4 className="text-sm font-medium">Recent WhatsApp replies</h4>
          {view.messages
            .filter((message) => message.agentId === agentId)
            .map((message) => (
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
                    {labels[message.state]}
                  </Badge>
                  {["failed", "uncertain", "expired"].includes(
                    message.state
                  ) && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || !!attempt || !view.enabled || archived}
                      onClick={() =>
                        message.state === "uncertain"
                          ? setResend(message.id)
                          : retry(message.id, false)
                      }
                    >
                      Retry reply
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {new Date(message.createdAt).toLocaleString()}
                </p>
                {message.error && (
                  <p className="text-sm text-muted-foreground">
                    {message.error}
                  </p>
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
              The previous send may have reached WhatsApp. Check it first.
              Sending again may create a duplicate.
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
  agentId,
  agentName,
  archived,
  disabled,
  configure,
}: {
  view: WhatsAppView | null
  agentId: string
  agentName: string
  archived: boolean
  disabled: boolean
  configure: (enabled: boolean) => unknown
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium">WhatsApp</h3>
      <p className="text-sm text-muted-foreground">
        {view?.configured
          ? "Send text from your connected WhatsApp account. Approvals stay in Pi and Executor."
          : "WhatsApp Business setup is pending. Once connected, choose which agent receives your messages."}
      </p>
      {view?.enabled && (
        <p className="text-sm">
          New WhatsApp messages go to {view.agentName}. Earlier requests keep
          their original agent.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={
            !view?.configured ||
            disabled ||
            archived ||
            (view.enabled && view.agentId === agentId)
          }
          onClick={() => configure(true)}
        >
          <MessageCircle data-icon="inline-start" />
          {view?.enabled ? `Route WhatsApp to ${agentName}` : "Enable WhatsApp"}
        </Button>
        {view?.enabled && (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => configure(false)}
          >
            Disable WhatsApp
          </Button>
        )}
      </div>
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
