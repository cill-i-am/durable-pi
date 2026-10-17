import { Schema } from "effect"
import { Copy, Mail } from "lucide-react"
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
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group"
import {
  EmailView,
  type ConfigureEmail,
  type RetryEmail,
} from "@/email/contracts"
import { agentApi, ApiError } from "@/http/client"
import { poll } from "@/http/poll"

const labels = {
  queued: "Queued",
  waiting: "Agent is working",
  sending: "Sending reply",
  sent: "Sent",
  failed: "Send failed",
  uncertain: "Delivery unconfirmed",
  cancelled: "Cancelled",
}
type Change =
  | { path: "configure"; body: ConfigureEmail }
  | { path: "retry"; body: typeof RetryEmail.Type }
const toggleDisabled = (
  view: EmailView | null,
  busy: boolean,
  attempt: Change | null,
  archived: boolean
) =>
  (!view?.configured && !view?.enabled) ||
  busy ||
  !!attempt ||
  (archived && !view?.enabled)
export function EmailSettings({
  agentId,
  archived,
  onPendingChange,
}: {
  agentId: string
  archived: boolean
  onPendingChange: (pending: boolean) => void
}) {
  const [view, setView] = useState<EmailView | null>(null)
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
      const result = Schema.decodeUnknownSync(EmailView)(
        await agentApi(agentId)("email")
      )
      if (sequence.current === generation) setView(result)
    } catch (cause) {
      if (sequence.current === generation)
        setError(
          cause instanceof Error ? cause.message : "Could not load email."
        )
    }
  }, [agentId])
  useEffect(() => {
    const stop = poll(
      async () => {
        if (document.visibilityState === "visible") await refresh()
      },
      5000,
      true
    )
    return () => {
      stop()
      // oxlint-disable-next-line react/exhaustive-deps -- This ref is a response generation, not a DOM node.
      sequence.current++
    }
  }, [refresh])
  useEffect(() => {
    onPendingChange(busy || attempt !== null)
  }, [busy, attempt, onPendingChange])
  async function change(input: Change) {
    if (lock.current) return
    lock.current = true
    sequence.current++
    setBusy(true)
    setAttempt(input)
    setError("")
    try {
      const result = Schema.decodeUnknownSync(EmailView)(
        await agentApi(agentId)(`email/${input.path}`, input.body)
      )
      setView(result)
      setAttempt(null)
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) setAttempt(null)
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
      body: { id, operationId: crypto.randomUUID(), acknowledgeDuplicateRisk },
    })
  return (
    <div className="flex flex-col gap-4">
      <FieldGroup>
        <Field>
          <FieldLabel>Email this agent</FieldLabel>
          <FieldDescription>
            {view?.configured
              ? "Send text from your enrolled email address. Replies return to that inbox. Tool approvals stay in Pi."
              : "Email is not available yet."}
          </FieldDescription>
          <Button
            variant="outline"
            size="sm"
            disabled={toggleDisabled(view, busy, attempt, archived)}
            onClick={() =>
              view &&
              change({
                path: "configure",
                body: {
                  enabled: !view.enabled,
                  revision: view.revision,
                  operationId: crypto.randomUUID(),
                },
              })
            }
          >
            <Mail data-icon="inline-start" />
            {view?.enabled ? "Disable email" : "Enable email"}
          </Button>
          {view?.enabled && (
            <FieldDescription>
              Disabling email cancels unsent replies. Re-enabling gives this
              agent a new private address.
            </FieldDescription>
          )}
        </Field>
        {view?.address && (
          <Field>
            <FieldLabel htmlFor={`agent-email-${agentId}`}>
              Private email address
            </FieldLabel>
            <InputGroup>
              <InputGroupInput
                id={`agent-email-${agentId}`}
                readOnly
                value={view.address}
              />
              <InputGroupAddon align="inline-end">
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Copy email address"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(view.address!)
                      setError("")
                    } catch {
                      setError(
                        "Could not copy. Select the address and copy it manually."
                      )
                    }
                  }}
                >
                  <Copy />
                </Button>
              </InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              Keep this address private. Emails with attachments are rejected;
              add files in Pi.
            </FieldDescription>
          </Field>
        )}
      </FieldGroup>
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
          Reload email
        </Button>
      )}
      {!!view?.messages.length && (
        <section
          aria-label="Recent email deliveries"
          className="flex flex-col gap-3"
        >
          <h3>Recent email</h3>
          {view.messages.map((message) => (
            <div key={message.id} className="flex flex-col gap-1">
              <p className="break-words">{message.subject || "(no subject)"}</p>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{labels[message.state]}</Badge>
                {["failed", "uncertain"].includes(message.state) && (
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
              {message.error && (
                <p className="text-sm text-muted-foreground">{message.error}</p>
              )}
            </div>
          ))}
        </section>
      )}
      <AlertDialog
        open={resend !== null}
        onOpenChange={(open) => {
          if (!open) setResend(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this reply again?</AlertDialogTitle>
            <AlertDialogDescription>
              The previous send may have reached your inbox. Check it first.
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
    </div>
  )
}
