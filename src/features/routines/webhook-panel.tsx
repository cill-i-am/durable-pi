import { ArrowLeft, KeyRound } from "lucide-react"

import { CopyButton } from "@/components/copy-button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { Routine } from "@/routines/contracts"

import { useWebhook } from "./use-webhook"

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
  const {
    info,
    attempt,
    busy,
    error,
    message,
    key,
    send,
    resolve,
    retry,
    refresh,
  } = useWebhook(agentId, routine.id, onPendingChange)
  const endpoint = new URL(
    `/api/hooks/${agentId}/${routine.id}`,
    typeof window === "undefined"
      ? "https://app.internal"
      : window.location.origin
  ).href
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
        the key can trigger this routine while it is active. The bot&apos;s
        existing permissions and approvals still apply.
      </p>
      {error && (
        <Alert>
          <AlertDescription>
            {error}
            {!attempt && (
              <Button
                variant="link"
                size="sm"
                disabled={busy}
                onClick={() => void refresh()}
              >
                Retry settings
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
      {attempt && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy} onClick={() => void retry()}>
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
              <CopyButton
                text={endpoint}
                label="Copy webhook endpoint"
                variant="outline"
                size="icon"
              />
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
                <CopyButton
                  text={key.value}
                  label="Copy webhook key"
                  variant="outline"
                  size="icon"
                />
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
              Use the canonical endpoint above. Keep the key in your
              service&apos;s secret store; never put it in a URL or a chat
              message. This endpoint does not verify vendor-specific signatures.
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
