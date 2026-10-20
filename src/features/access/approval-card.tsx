import { Schema } from "effect"
import { ShieldQuestion } from "lucide-react"
import { useId, useRef, useState } from "react"

import { AccessState, type Approval, type ToolPolicy } from "@/access/contracts"
import { CopyButton } from "@/components/copy-button"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  CardFooter,
} from "@/components/ui/card"
import {
  CodeBlock,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockActions,
  CodeBlockContent,
} from "@/components/ui/code-block"
import { agentApi } from "@/http/client"

import { approvalDecision, type ConfirmedDecision } from "./decision"

export function ApprovalCard({
  approval,
  agentId,
  disabled,
  toolLabel,
  toolPolicy,
  agentName = "this agent",
}: {
  approval: Approval
  agentId: string
  disabled: boolean
  toolLabel?: string
  toolPolicy?: ToolPolicy
  agentName?: string
}) {
  const scopeId = useId()
  const [busy, setBusy] = useState(false)
  const [confirmed, setConfirmed] = useState<ConfirmedDecision | null>(null)
  const decided = approvalDecision(approval, confirmed)
  const [error, setError] = useState("")
  const lock = useRef(false)
  async function decide(approve: boolean, remember = false) {
    if (
      lock.current ||
      disabled ||
      approval.status !== "pending" ||
      decided !== null
    )
      return
    if (remember && (!toolPolicy || toolPolicy.name !== approval.tool)) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const state = Schema.decodeUnknownSync(AccessState)(
        await agentApi(agentId)("access/decide", {
          id: approval.id,
          approve,
          expectedRevision: approval.revision,
          ...(remember && toolPolicy
            ? { remember: { expectedPolicyRevision: toolPolicy.revision } }
            : {}),
        })
      )
      if (
        remember &&
        state.tools.find((tool) => tool.name === approval.tool)?.mode !==
          "allow"
      )
        throw new Error(
          "Tool access changed. Refresh before allowing future calls."
        )
      setConfirmed({ revision: approval.revision, approve, remember })
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save your decision."
      )
    } finally {
      setBusy(false)
      lock.current = false
    }
  }
  const pending = approval.status === "pending" && decided === null
  const heading = approvalHeading(approval, decided, confirmed)
  return (
    <Card
      role="region"
      aria-label={`Approval for ${toolLabel ?? approval.tool}`}
      className="approval-card mt-4 min-w-0"
      data-pending={pending}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-3">
          <ShieldQuestion className="size-5 shrink-0" />
          {heading}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-3">
        {approval.status === "interrupted" && (
          <p className="text-sm">Check the outcome before retrying.</p>
        )}
        <p className="text-sm">
          <strong>{toolLabel ?? approval.tool}</strong>
          {pending ? " · Review these inputs" : " · Action inputs"}
        </p>
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>Action inputs</CodeBlockTitle>
            <CodeBlockActions>
              <CopyButton
                text={formatInput(approval.input)}
                label="Copy action inputs"
              />
            </CodeBlockActions>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-64">
            {formatInput(approval.input)}
          </CodeBlockContent>
        </CodeBlock>
        {pending && (
          <p className="text-xs text-muted-foreground">
            This action request expires at{" "}
            {new Date(approval.expiresAt).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })}
            .
          </p>
        )}
        {pending && (
          <p id={scopeId} className="text-xs text-muted-foreground">
            Always allow lets <strong>{agentName}</strong> use{" "}
            <strong>{toolLabel ?? approval.tool}</strong> with any inputs until
            you change it in Settings → Tool access. Other tools and internet
            settings stay separate.
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
      {pending && (
        <CardFooter className="flex-wrap gap-2">
          <Button
            size="sm"
            className="min-h-10"
            disabled={busy || disabled}
            onClick={() => void decide(true)}
          >
            {busy ? "Saving decision…" : "Allow once"}
          </Button>
          <Button
            size="sm"
            className="min-h-10"
            variant="outline"
            aria-describedby={scopeId}
            disabled={
              busy ||
              disabled ||
              !toolPolicy ||
              toolPolicy.name !== approval.tool ||
              toolPolicy.mode === "deny"
            }
            onClick={() => void decide(true, true)}
          >
            Always allow
          </Button>
          <Button
            size="sm"
            className="min-h-10"
            variant="outline"
            disabled={busy || disabled}
            onClick={() => void decide(false)}
          >
            Deny
          </Button>
        </CardFooter>
      )}
    </Card>
  )
}
function formatInput(input: string) {
  try {
    return JSON.stringify(JSON.parse(input), null, 2)
  } catch {
    return input
  }
}

function approvalHeading(
  approval: Approval,
  decided: boolean | null,
  confirmed: ConfirmedDecision | null
) {
  return approval.status === "pending"
    ? decided === true
      ? confirmed?.remember
        ? "Tool allowed for this agent"
        : "Approved for this action"
      : decided === false
        ? "Denied"
        : "Your approval is needed"
    : {
        approved: "Approved",
        running: "Approved · running",
        done: "Action completed",
        denied: "Denied",
        cancelled: "Cancelled",
        expired: "Approval expired",
        interrupted: "Interrupted",
      }[approval.status]
}
