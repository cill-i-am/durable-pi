import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Badge } from "@workspace/ui/components/badge"
import { Button } from "@workspace/ui/components/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@workspace/ui/components/field"
import { Copy, Mail } from "lucide-react"

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
} from "@/components/ui/input-group"
import type { EmailView } from "@/email/contracts"
import { useChannelSettings } from "@/features/channel-settings/use-channel-settings"
import { replyProgressText, replyRetryLabel } from "@/replies/progress"

const labels = {
  queued: "Queued",
  waiting: "Agent is working",
  sending: "Sending reply",
  sent: "Sent",
  failed: "Send failed",
  uncertain: "Delivery unconfirmed",
  cancelled: "Cancelled",
}
const toggleDisabled = (
  view: EmailView | null,
  busy: boolean,
  attempt: unknown,
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
  const settings = useChannelSettings(
    "email",
    agentId,
    archived,
    true,
    onPendingChange
  )
  const {
    error,
    busy,
    attempt,
    resend,
    change,
    refresh,
    retrySame,
    confirm,
    cancel,
    setError,
  } = settings
  const view =
    settings.view && "address" in settings.view ? settings.view : null
  const retry = (id: string, acknowledgeDuplicateRisk: boolean) =>
    change({
      path: "retry",
      body: { id, operationId: crypto.randomUUID(), acknowledgeDuplicateRisk },
    })
  return (
    <div className="settings-channel">
      <FieldGroup>
        <Field>
          <FieldLabel>Email this agent</FieldLabel>
          <FieldDescription>
            {view?.configured
              ? "Email your assistant from your enrolled inbox. Send files, receive replies and review action approvals by email."
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
              Keep this address private. Attach up to four files, 8 MiB each and
              20 MiB per email. Approval emails let you approve once or deny.
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
        <Button variant="outline" disabled={busy} onClick={retrySame}>
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
                <Badge variant="secondary">
                  {message.preparingFiles
                    ? "Preparing files"
                    : labels[message.state]}
                </Badge>
                {["failed", "uncertain"].includes(message.state) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !!attempt || !view.enabled || archived}
                    onClick={() => retry(message.id, false)}
                  >
                    {replyRetryLabel(message.progress)}
                  </Button>
                )}
              </div>
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
        onOpenChange={(open) => {
          if (!open) cancel()
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send this reply again?</AlertDialogTitle>
            <AlertDialogDescription>
              Confirmed messages will be skipped. The next unconfirmed message
              may have reached your inbox. Check it first. Sending again may
              create a duplicate.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button onClick={confirm}>Send again</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
