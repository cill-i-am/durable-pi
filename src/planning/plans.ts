import type { Effect } from "effect"
import type {
  Evidence,
  EvidenceRef,
  Plan,
  PlanDetail,
  PlanFailure,
  PlanReceipt,
  PlanSummary,
  PlanUpdate,
} from "./contracts"

export type PlanSource = {
  turnId: string
  inputRevision: number
  inputIds: string[]
  pendingInputs?: boolean
  steering?: {
    id: string
    text: string
    hasAttachments?: boolean
    nativeDelivered?: boolean
  }[]
}
export type PlanEvidence<TRequirements = never> = (
  ref: EvidenceRef,
  roots: readonly string[]
) => Effect.Effect<Evidence, PlanFailure, TRequirements>
export type PlanControl = {
  current: (turnId: string) => PlanSource | undefined
  cancelled: (turnId: string) => boolean
  receipts: (roots: readonly string[]) => EvidenceRef[]
}
export type PlanAuthority<TRequirements = never> = PlanControl & {
  evidence: PlanEvidence<TRequirements>
}
export type Plans<TRequirements = never> = {
  list: (
    offset?: number,
    limit?: number
  ) => Effect.Effect<PlanSummary[], PlanFailure, TRequirements>
  read: (
    id: string,
    before?: number
  ) => Effect.Effect<PlanDetail, PlanFailure, TRequirements>
  update: (
    input: PlanUpdate,
    source: PlanSource
  ) => Effect.Effect<PlanReceipt, PlanFailure, TRequirements>
  cancel: (turnId: string) => Effect.Effect<void, PlanFailure, TRequirements>
  context: (source: PlanSource) => Effect.Effect<
    {
      current: Plan | null
      recent: PlanSummary[]
      receipts: EvidenceRef[]
    },
    PlanFailure,
    TRequirements
  >
}
