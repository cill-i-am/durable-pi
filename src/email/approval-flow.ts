import { Effect } from "effect"

import type { AccessGate } from "../access/gate"
import {
  emailApprovalNotice,
  emailDecision,
  type EmailApprovalProofs,
} from "./approvals"
import {
  EmailRejected,
  EmailUnavailable,
  type EmailFailure,
  type EmailRecord,
} from "./contracts"
import type { EmailPersistence } from "./persistence"

/** Email and access ledgers must share the same actor transaction group. */
export function emailApprovals(
  records: EmailPersistence,
  gate: AccessGate,
  host: {
    proofs: EmailApprovalProofs
    active: () => Effect.Effect<boolean, EmailFailure>
    wakeConversation: () => Effect.Effect<void, EmailFailure>
    members: (
      id: string
    ) => Effect.Effect<readonly { id: string }[], EmailFailure>
  }
) {
  return {
    notices: (record: EmailRecord) =>
      Effect.gen(function* () {
        const members = yield* host.members(record.id)
        const roots = new Set([record.id, ...members.map((turn) => turn.id)])
        const state = yield* gate.state()
        return state.approvals
          .filter(
            (approval) =>
              approval.status === "pending" && roots.has(approval.turnId)
          )
          .map((approval) => ({
            key: `${record.id}:${approval.id}:${approval.revision}`,
            text: emailApprovalNotice(
              approval,
              host.proofs.sign(record.recipient, approval),
              state.tools.find((tool) => tool.name === approval.tool)
            ),
          }))
      }).pipe(Effect.mapError(() => new EmailUnavailable())),
    decide: (record: EmailRecord) =>
      Effect.gen(function* () {
        const decision = emailDecision(record.body)
        if (!decision)
          return yield* new EmailRejected({
            message:
              "Reply APPROVE or DENY with the code from the approval request.",
          })
        const proof = yield* Effect.try({
          try: () =>
            host.proofs.verify(record.recipient, decision.token, Date.now()),
          catch: () =>
            new EmailRejected({
              message:
                "This approval is invalid or has expired. Review the current action in Pi.",
            }),
        })
        const operation = yield* gate.operation(proof.id)
        if (
          !operation ||
          operation.turnId !== proof.turnId ||
          operation.expiresAt !== proof.expiresAt
        )
          return yield* new EmailRejected({
            message:
              "This approval no longer matches the pending action. Review it in Pi.",
          })
        yield* gate.decide(
          proof.id,
          decision.approve,
          proof.revision,
          undefined,
          (change) => records.decide(record.id, host.active, () => change)
        )
        yield* host.wakeConversation()
        return decision.approve
          ? "Approved once. Your assistant can continue this action."
          : "Denied. Your assistant has been told not to carry out this action."
      }).pipe(
        Effect.mapError((error) =>
          error._tag === "EmailRejected"
            ? error
            : error._tag === "AccessConflict" || error._tag === "AccessDenied"
              ? new EmailRejected({ message: error.message })
              : new EmailUnavailable()
        )
      ),
  }
}
