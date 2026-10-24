import { ShieldQuestion } from "lucide-react"
import { useId } from "react"

import { type Approval, type ToolPolicy } from "@/access/contracts"
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

import { approvalDecision, type ConfirmedDecision } from "./decision"
import { useApproval } from "./use-approval"

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
  const { busy, confirmed, error, decide, blocked } = useApproval({
    agentId,
    approval,
    disabled,
    policy: toolPolicy ?? null,
  })
  const decided = approvalDecision(approval, confirmed)
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
            disabled={blocked(true)}
            onClick={() => void decide(true)}
          >
            {busy ? "Saving decision…" : "Allow once"}
          </Button>
          <Button
            size="sm"
            className="min-h-10"
            variant="outline"
            aria-describedby={scopeId}
            disabled={blocked(true, true)}
            onClick={() => void decide(true, true)}
          >
            Always allow
          </Button>
          <Button
            size="sm"
            className="min-h-10"
            variant="outline"
            disabled={blocked(false)}
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
