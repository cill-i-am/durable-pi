import { useEffect, useRef, useState } from "react"
import { Schema } from "effect"
import { ArrowLeft, Copy, KeyRound } from "lucide-react"
import type { Routine } from "@/routines/contracts"
import { type ConfigureWebhook, WebhookInfo } from "@/webhooks/contracts"
import { agentApi, agentUrl, api } from "@/http/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Field, FieldLabel } from "@/components/ui/field"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"

function createKey() {
  return (
    "rpwh_" +
    Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
  )
}
export function WebhookPanel({
  agentId,
  routine,
  onBack,
  onPendingChange,
}: {
  agentId: string
  routine: Routine
  onBack: () => void
  onPendingChange: (value: boolean) => void
}) {
  const [info, setInfo] = useState<WebhookInfo | null>(null)
  const [attempt, setAttempt] = useState<ConfigureWebhook | null>(null)
  const [busy, setBusy] = useState(false),
    lock = useRef(false)
  const [error, setError] = useState(""),
    [message, setMessage] = useState("")
  const [key, setKey] = useState<{ value: string; revision: number } | null>(
    null
  )
  const endpoint = new URL(
    `/api/hooks/${agentId}/${routine.id}`,
    typeof window === "undefined"
      ? "https://app.internal"
      : window.location.origin
  ).href
  const load = async () =>
    Schema.decodeUnknownSync(WebhookInfo)(
      await api(`${agentUrl(agentId, "webhooks")}&routine=${routine.id}`)
    )
  useEffect(() => {
    let mounted = true
    void load()
      .then((value) => {
        if (mounted) setInfo(value)
      })
      .catch(() => {
        if (mounted)
          setError(
            "Could not load webhook settings. Return to routines and try again."
          )
      })
    return () => {
      mounted = false
    }
    // One editor owns this routine until it is closed.
  }, [agentId, routine.id])
  async function send(change: ConfigureWebhook) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setAttempt(change)
    onPendingChange(true)
    setError("")
    setMessage("")
    setKey(null)
    let confirmed = false
    try {
      const result = Schema.decodeUnknownSync(WebhookInfo)(
        await agentApi(agentId)("webhooks/configure", change)
      )
      const current = await load()
      setInfo(current)
      const stillCurrent = current.revision === result.revision
      setKey(
        change.key && stillCurrent
          ? { value: change.key, revision: result.revision }
          : null
      )
      confirmed = true
      setAttempt(null)
      setMessage(
        !stillCurrent
          ? "The webhook changed again in another tab. Current settings have been loaded; rotate to create a new key."
          : change.key
            ? "Key saved. Copy it now; it cannot be retrieved later."
            : "Webhook disabled. Unadmitted events were cancelled."
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "This change was not confirmed. Retry the same request or resolve it."
      )
    } finally {
      lock.current = false
      setBusy(false)
      onPendingChange(!confirmed)
    }
  }
  async function resolve() {
    if (!attempt || lock.current) return
    lock.current = true
    setBusy(true)
    onPendingChange(true)
    setError("")
    let confirmed = false
    try {
      const result = await agentApi(agentId)<{ applied: boolean }>(
        "webhooks/cancel",
        { operationId: attempt.operationId }
      )
      const current = await load()
      setInfo(current)
      setKey(
        result.applied &&
          attempt.key &&
          current.revision === attempt.expectedRevision + 1
          ? { value: attempt.key, revision: current.revision }
          : null
      )
      setAttempt(null)
      confirmed = true
      setMessage(
        result.applied
          ? "The change was already applied. Current settings have been loaded."
          : "The unconfirmed change was cancelled."
      )
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not resolve this request. Retry."
      )
    } finally {
      lock.current = false
      setBusy(false)
      onPendingChange(!confirmed)
    }
  }
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setMessage(`${label} copied.`)
    } catch {
      setError("Clipboard access failed. Select and copy the field instead.")
    }
  }
  const locked = busy || !!attempt
  return (
    <section className="flex min-w-0 flex-col gap-5">
      <Button
        className="self-start"
        size="sm"
        variant="ghost"
        disabled={locked}
        onClick={onBack}
      >
        <ArrowLeft /> All routines
      </Button>
      <div className="flex items-center justify-between gap-3">
        <h2 className="min-w-0 text-sm font-medium break-words">
          {routine.title} · Webhook
        </h2>
        {info && (
          <Badge variant="secondary">
            {info.enabled ? "Enabled" : "Disabled"}
          </Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Let a service trigger these instructions with a JSON event. Anyone with
        the key can trigger this routine while it is active. The bot's existing
        permissions and approvals still apply.
      </p>
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
      {attempt && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void send(attempt)}>
            Retry same change
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void resolve()}
          >
            Resolve and cancel
          </Button>
        </div>
      )}
      {!info ? (
        <p className="text-sm text-muted-foreground">Loading webhook…</p>
      ) : (
        <>
          <Field>
            <FieldLabel htmlFor="webhook-endpoint">POST endpoint</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="webhook-endpoint"
                value={endpoint}
                readOnly
                className="min-w-0 font-mono text-xs"
              />
              <Button
                size="icon"
                variant="outline"
                aria-label="Copy webhook endpoint"
                onClick={() => void copy(endpoint, "Endpoint")}
              >
                <Copy />
              </Button>
            </div>
          </Field>
          {key && info.revision === key.revision && (
            <Field>
              <FieldLabel htmlFor="webhook-key">
                New key · copy before leaving
              </FieldLabel>
              <div className="flex gap-2">
                <Input
                  id="webhook-key"
                  type="password"
                  autoComplete="off"
                  readOnly
                  value={key.value}
                  className="min-w-0 font-mono text-xs"
                />
                <Button
                  size="icon"
                  variant="outline"
                  aria-label="Copy webhook key"
                  onClick={() => void copy(key.value, "Key")}
                >
                  <Copy />
                </Button>
              </div>
            </Field>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={locked}
              onClick={() =>
                void send({
                  routineId: routine.id,
                  operationId: crypto.randomUUID(),
                  expectedRevision: info.revision,
                  key: createKey(),
                })
              }
            >
              <KeyRound />
              {info.enabled ? "Rotate key" : "Enable and create key"}
            </Button>
            {info.enabled && (
              <Button
                size="sm"
                variant="outline"
                disabled={locked}
                onClick={() =>
                  void send({
                    routineId: routine.id,
                    operationId: crypto.randomUUID(),
                    expectedRevision: info.revision,
                    key: null,
                  })
                }
              >
                Disable webhook
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Rotating or disabling the key cancels waiting events. A reply
            already admitted can finish; use Stop in Recent runs to end it.{" "}
            {info.accepted} events accepted.
          </p>
          <div className="space-y-3 border-t pt-4 text-xs text-muted-foreground">
            <h3 className="font-medium text-foreground">Send an event</h3>
            <p>
              Set <code>Authorization: Bearer YOUR_KEY</code>,{" "}
              <code>X-Event-Id: UNIQUE_EVENT_ID</code> and{" "}
              <code>Content-Type: application/json</code>. Send a JSON object up
              to 16 KB.
            </p>
            <p>
              A 202 response means accepted. Retrying the same event ID and JSON
              returns the same run with 200. Reusing an ID with different data
              returns 409. A 429 response means busy: wait at least 60 seconds
              and retry with the same ID.
            </p>
            <p>
              Use the canonical endpoint above. Keep the key in your service's
              secret store; never put it in a URL or a chat message. This
              endpoint does not verify vendor-specific signatures.
            </p>
            {routine.status !== "active" && (
              <p className="text-foreground">
                This routine is paused. Resume it in All routines to accept new
                events.
              </p>
            )}
          </div>
        </>
      )}
    </section>
  )
}
