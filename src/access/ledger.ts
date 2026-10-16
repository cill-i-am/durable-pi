import type { Effect } from "effect"

import type { AccessMode, Approval, ToolPolicy } from "./contracts"
import type { AccessError } from "./gate"

export type ToolIntent = {
  id: string
  turnId: string
  tool: string
  input: string
}
export type ToolOperation = Approval & {
  grantRevision: number
  result: string | null
  decision: string | null
}
export type DispatchDecision = "pending" | "execute" | { result: string }

/** Durable authorization ledger. Claims fence current grants and persist dispatch
 * before external work. A completed receipt replays; an uncertain dispatch never
 * retries unless the operation is explicitly recoverable and its grant is valid.
 */
export interface AccessLedger {
  policies: () => Effect.Effect<ToolPolicy[], AccessError>
  pending: () => Effect.Effect<Approval[], AccessError>
  awaitingApproval: (turnId: string) => Effect.Effect<boolean, AccessError>
  get: (id: string) => Effect.Effect<ToolOperation | undefined, AccessError>
  begin: (
    intent: ToolIntent,
    canRun?: (turnId: string) => Effect.Effect<boolean, AccessError>
  ) => Effect.Effect<ToolOperation, AccessError>
  claim: (
    id: string,
    recoverable?: boolean,
    canRun?: (turnId: string) => Effect.Effect<boolean, AccessError>
  ) => Effect.Effect<DispatchDecision, AccessError>
  finish: (id: string, result: string) => Effect.Effect<void, AccessError>
  cancel: (turnId: string) => Effect.Effect<void, AccessError>
  revoke: (name: string) => Effect.Effect<void, AccessError>
  update: (
    name: string,
    expectedRevision: number,
    mode: AccessMode
  ) => Effect.Effect<ToolPolicy, AccessError>
  decide: (
    id: string,
    approve: boolean,
    expectedRevision: number,
    remember?: { expectedPolicyRevision: number }
  ) => Effect.Effect<ToolOperation, AccessError>
}
