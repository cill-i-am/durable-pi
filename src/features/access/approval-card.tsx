import { useRef, useState } from "react"
import { ShieldQuestion } from "lucide-react"
import type { Approval } from "@/access/contracts"
import { agentApi } from "@/http/client"
import { Button } from "@/components/ui/button"
import { approvalDecision, type ConfirmedDecision } from "./decision"

export function ApprovalCard({
  approval,
  agentId,
  onDecided,
  disabled,
}: {
  approval: Approval
  agentId: string
  onDecided: () => void
  disabled: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState<ConfirmedDecision | null>(null)
  const decided = approvalDecision(approval, confirmed)
  const [error, setError] = useState("")
  const lock = useRef(false)
  async function decide(approve: boolean) {
    if (lock.current || disabled || decided !== null) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      await agentApi(agentId)("access/decide", {
        id: approval.id,
        approve,
        expectedRevision: approval.revision,
      })
      setConfirmed({ revision: approval.revision, approve })
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save your decision."
      )
    } finally {
      setBusy(false)
      lock.current = false
      onDecided()
    }
  }
  const approved = decided === true || approval.status === "approved"
  return (
    <section
      aria-label={`Approval for ${approval.tool}`}
      className="my-4 space-y-3 rounded-xl border border-primary/25 bg-muted/30 p-4"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <ShieldQuestion className="size-4" />
        {approved
          ? "Approved · resuming"
          : decided === false
            ? "Denied"
            : "Your approval is needed"}
      </div>
      <p className="text-sm">
        Run <strong className="font-mono">{approval.tool}</strong> with these
        inputs?
      </p>
      <pre className="max-h-64 overflow-auto rounded-md bg-background p-3 font-mono text-xs break-all whitespace-pre-wrap">
        {formatInput(approval.input)}
      </pre>
      <p className="text-xs text-muted-foreground">
        Applies to this action once. Expires at{" "}
        {new Date(approval.expiresAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })}
        .
      </p>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!approved && decided === null && (
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || disabled}
            onClick={() => void decide(true)}
          >
            {busy ? "Saving decision…" : "Allow once"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void decide(false)}
          >
            Deny
          </Button>
        </div>
      )}
    </section>
  )
}
function formatInput(input: string) {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}
