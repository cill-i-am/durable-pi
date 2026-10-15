import type { AccessMode, Approval, ToolPolicy } from "./contracts"

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
  policies: () => ToolPolicy[]
  pending: () => Approval[]
  awaitingApproval: (turnId: string) => boolean
  get: (id: string) => ToolOperation | undefined
  begin: (intent: ToolIntent) => ToolOperation
  claim: (id: string, recoverable?: boolean) => DispatchDecision
  finish: (id: string, result: string) => void
  cancel: (turnId: string) => void
  revoke: (name: string) => void
  update: (
    name: string,
    expectedRevision: number,
    mode: AccessMode
  ) => ToolPolicy
  decide: (
    id: string,
    approve: boolean,
    expectedRevision: number,
    remember?: { expectedPolicyRevision: number }
  ) => ToolOperation
}
