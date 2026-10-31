import { Button } from "@workspace/ui/components/button"
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@workspace/ui/components/sheet"
import { useIsMobile } from "@workspace/ui/hooks/use-mobile"
import { ChevronDown, ChevronRight } from "lucide-react"
import { useCallback, useEffect, useId } from "react"

import type { Approval, ToolPolicy } from "@/access/contracts"
import type { ChatState } from "@/conversations/contracts"

import {
  approvalDecision,
  approvalToolLabel,
  formatApprovalInput,
} from "./decision"
import { decisionKey, pendingDecisions } from "./decision-dock.machine"
import { useApproval } from "./use-approval"
import { useDecisionDock } from "./use-decision-dock"

import "./decision-dock.css"

export type DecisionDockProps = {
  agentId: string
  agentName: string
  access: ChatState["access"]
  disabled: boolean
  onRefresh: () => void
}

const noApprovals: readonly Approval[] = []

export function DecisionDock({
  agentId,
  agentName,
  access,
  disabled,
  onRefresh,
}: DecisionDockProps) {
  const approvals = access?.approvals ?? noApprovals
  const mobile = useIsMobile()
  const { snapshot, send } = useDecisionDock({ agentId, approvals })
  const queueId = useId()
  const acknowledged = useCallback(
    (key: string, approve: boolean) => {
      send({ type: "ACKNOWLEDGED", key, approve })
      onRefresh()
    },
    [send, onRefresh]
  )
  const lock = useCallback(
    (key: string, locked: boolean) => {
      send({ type: "LOCK", key, locked })
    },
    [send]
  )
  if (!snapshot) return null
  const pending = pendingDecisions(snapshot.context).flatMap((item) => {
    const current = approvals.find(
      (approval) =>
        approval.status === "pending" &&
        decisionKey(approval) === decisionKey(item)
    )
    return current ? [current] : []
  })
  const active = pending.find(
    (item) => decisionKey(item) === snapshot.context.selected
  )
  const expanded = snapshot.matches("queue")
  const reviewing = snapshot.matches("review")
  const count = `${pending.length} awaiting approval`
  const queue = (
    <div
      id={queueId}
      className="decision-dock-queue"
      role="group"
      aria-label="Pending decisions"
    >
      {pending
        .filter((item) => item !== active)
        .map((item) => (
          <Button
            key={decisionKey(item)}
            className="decision-dock-queue-row"
            variant="ghost"
            disabled={snapshot.context.locked}
            onClick={() => send({ type: "SELECT", key: decisionKey(item) })}
          >
            <span>{approvalToolLabel(item, access?.tools)}</span>
            <ChevronRight aria-hidden="true" />
          </Button>
        ))}
      {active && pending.length === 1 && (
        <p className="decision-dock-queue-empty">
          This is the only pending request.
        </p>
      )}
    </div>
  )
  if (!pending.length && !snapshot.context.notice) return null
  return (
    <section className="decision-dock" aria-label="Decisions awaiting approval">
      {snapshot.context.notice && (
        <p className="decision-dock-receipt" role="status">
          {snapshot.context.notice}
        </p>
      )}
      {active ? (
        <DecisionRequest
          key={decisionKey(active)}
          approval={active}
          policy={access?.tools.find((tool) => tool.name === active.tool)}
          agentId={agentId}
          agentName={agentName}
          disabled={disabled}
          count={count}
          queueId={queueId}
          expanded={expanded}
          reviewing={reviewing}
          onQueue={() => send({ type: "QUEUE" })}
          onReview={() =>
            send({
              type: "REVIEW",
              key: decisionKey(active),
              fromQueue: expanded,
            })
          }
          onClose={() => send({ type: "CLOSE" })}
          onDefer={() => send({ type: "DEFER", key: decisionKey(active) })}
          onLock={lock}
          onAcknowledged={acknowledged}
          onRefresh={onRefresh}
        />
      ) : pending.length > 0 ? (
        <div className="decision-dock-deferred">
          <p>Review when you’re ready</p>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={queueId}
            onClick={() => send({ type: "QUEUE" })}
          >
            {count}
            <ChevronDown aria-hidden="true" />
          </Button>
        </div>
      ) : null}
      {expanded && !mobile && pending.length > 0 && queue}
      <Sheet
        open={mobile && expanded}
        onOpenChange={(open) => {
          if (!open) send({ type: "QUEUE" })
        }}
      >
        <SheetContent className="decision-dock-queue-detail" side="bottom">
          <SheetHeader>
            <SheetTitle>{count}</SheetTitle>
            <SheetDescription>
              Review each action before allowing it.
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            {active && (
              <div className="decision-dock-queue-active">
                <h2>{approvalToolLabel(active, access?.tools)}</h2>
                <p>Requested by {agentName}</p>
                <Button
                  disabled={disabled || snapshot.context.locked}
                  onClick={() =>
                    send({
                      type: "REVIEW",
                      key: decisionKey(active),
                      fromQueue: true,
                    })
                  }
                >
                  Review action
                </Button>
              </div>
            )}
            {queue}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </section>
  )
}

type RequestProps = {
  approval: Approval
  policy: ToolPolicy | undefined
  agentId: string
  agentName: string
  disabled: boolean
  count: string
  queueId: string
  expanded: boolean
  reviewing: boolean
  onQueue: () => void
  onReview: () => void
  onClose: () => void
  onDefer: () => void
  onLock: (key: string, locked: boolean) => void
  onAcknowledged: (key: string, approve: boolean) => void
  onRefresh: () => void
}

function DecisionRequest({
  approval,
  policy,
  agentId,
  agentName,
  disabled,
  count,
  queueId,
  expanded,
  reviewing,
  onQueue,
  onReview,
  onClose,
  onDefer,
  onLock,
  onAcknowledged,
  onRefresh,
}: RequestProps) {
  const { ready, busy, uncertain, confirmed, error, blocked, decide } =
    useApproval({
      agentId,
      approval,
      disabled,
      policy: policy ?? null,
    })
  const decision = approvalDecision(approval, confirmed)
  const requestKey = decisionKey(approval)
  const scopeId = useId()
  const locked = busy || uncertain
  const label = policy?.title ?? approval.tool
  useEffect(() => {
    onLock(requestKey, locked)
  }, [ready, locked, onLock, requestKey, disabled, policy])
  useEffect(() => {
    if (decision !== null) onAcknowledged(requestKey, decision)
  }, [decision, requestKey, onAcknowledged])
  const submit = (approve: boolean, remember = false) => {
    if (blocked(approve, remember)) return
    // Lock queue progression before dispatch. The existing approval machine
    // rechecks the full view and current policy at the consequential boundary.
    onLock(requestKey, true)
    decide(approve, remember)
  }
  const actions = uncertain ? (
    <Button variant="outline" onClick={onRefresh}>
      Check status
    </Button>
  ) : (
    <>
      <Button
        disabled={blocked(true)}
        aria-busy={busy}
        onClick={() => submit(true)}
      >
        {busy ? "Saving decision…" : "Allow once"}
      </Button>
      <Button
        variant="outline"
        disabled={blocked(false)}
        onClick={() => submit(false)}
      >
        Deny
      </Button>
      <Button
        variant="outline"
        disabled={blocked(true, true)}
        aria-describedby={scopeId}
        onClick={() => submit(true, true)}
      >
        Always allow
      </Button>
      <Button variant="ghost" disabled={disabled || locked} onClick={onDefer}>
        Later
      </Button>
    </>
  )
  return (
    <>
      <div className="decision-dock-current" aria-busy={busy}>
        <div className="decision-dock-summary">
          <h2>{label}</h2>
          <p>Review the complete action inputs</p>
          <span>Requested by {agentName}</span>
        </div>
        <div className="decision-dock-controls">
          <Button
            className="decision-dock-count"
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            aria-controls={queueId}
            onClick={onQueue}
          >
            {count}
            <ChevronDown aria-hidden="true" />
          </Button>
          <div className="decision-dock-primary-actions">
            {!uncertain && (
              <Button
                variant="outline"
                disabled={disabled || locked}
                onClick={onDefer}
              >
                Later
              </Button>
            )}
            {uncertain ? (
              <Button variant="outline" onClick={onRefresh}>
                Check status
              </Button>
            ) : (
              <Button disabled={disabled || busy} onClick={onReview}>
                {busy ? "Saving decision…" : "Review action"}
              </Button>
            )}
          </div>
        </div>
      </div>
      {uncertain && (
        <p className="decision-dock-warning" role="alert">
          Your decision couldn’t be confirmed. Check the action status first.
        </p>
      )}
      <Sheet
        open={reviewing}
        onOpenChange={(open) => {
          if (!open) onClose()
        }}
      >
        <SheetContent className="decision-dock-detail" side="right">
          <SheetHeader>
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription>
              Requested by {agentName} · Awaiting your approval
            </SheetDescription>
          </SheetHeader>
          <SheetBody>
            <div className="decision-dock-input-heading">
              <h3>Complete action inputs</h3>
              <code>{approval.tool}</code>
            </div>
            <pre className="decision-dock-inputs">
              {formatApprovalInput(approval.input)}
            </pre>
            <p className="decision-dock-expiry">
              This request expires at{" "}
              {new Date(approval.expiresAt).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
              .
            </p>
            <p id={scopeId} className="decision-dock-permission">
              Always allow lets <strong>{agentName}</strong> use{" "}
              <strong>{label}</strong> with any inputs until you change it in
              Settings → Tool access.
            </p>
            {error && (
              <p className="decision-dock-warning" role="alert">
                {error}
              </p>
            )}
          </SheetBody>
          <SheetFooter className="decision-dock-detail-actions">
            {actions}
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  )
}
