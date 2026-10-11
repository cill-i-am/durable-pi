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

/** Conversation identity and input revision come from the host, never tool arguments. */
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
export type PlanAuthority = {
  current: (turnId: string) => PlanSource | undefined
  cancelled: (turnId: string) => boolean
  evidence: (
    ref: EvidenceRef,
    roots: readonly string[]
  ) => Effect.Effect<Evidence, PlanFailure>
  receipts: (roots: readonly string[]) => EvidenceRef[]
}
export type Plans = {
  list: (
    offset?: number,
    limit?: number
  ) => Effect.Effect<PlanSummary[], PlanFailure>
  read: (id: string, before?: number) => Effect.Effect<PlanDetail, PlanFailure>
  update: (
    input: PlanUpdate,
    source: PlanSource
  ) => Effect.Effect<PlanReceipt, PlanFailure>
  cancel: (turnId: string) => Effect.Effect<void, PlanFailure>
  context: (source: PlanSource) => Effect.Effect<
    {
      current: Plan | null
      recent: PlanSummary[]
      receipts: EvidenceRef[]
    },
    PlanFailure
  >
}
