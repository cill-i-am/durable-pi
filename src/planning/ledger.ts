import type { Effect } from "effect"

import type { Plan, PlanFailure, PlanReceipt, PlanRevision } from "./contracts"
import type { PlanEvidence } from "./plans"

export interface PlanBinding {
  planId: string
  cancelled: boolean
}
export interface PlanOperation {
  digest: string
  receipt: PlanReceipt | null
}
/** Mutable views and evidence belong to this one native commit callback. */
export interface PlanTransaction<TRequirements = never> {
  catalog: () => Effect.Effect<{ ids: string[] }, PlanFailure>
  document: (id: string) => Effect.Effect<{ value: Plan | null }, PlanFailure>
  history: (
    key: string
  ) => Effect.Effect<{ value: PlanRevision | null }, PlanFailure>
  binding: (turn: string) => Effect.Effect<PlanBinding, PlanFailure>
  operation: (id: string) => Effect.Effect<PlanOperation, PlanFailure>
  evidence: PlanEvidence<TRequirements>
}
export interface PlanLedger<TRequirements = never> {
  atomic: <T, TError, TInvocation>(
    change: (
      tx: PlanTransaction<TRequirements>
    ) => Effect.Effect<T, TError, TInvocation>
  ) => Effect.Effect<T, TError | PlanFailure, TInvocation>
  catalog: () => Effect.Effect<readonly string[], PlanFailure>
  binding: (turn: string) => Effect.Effect<PlanBinding | undefined, PlanFailure>
  history: (key: string) => Effect.Effect<PlanRevision | null, PlanFailure>
}
export type PlanDigest = (value: unknown) => Effect.Effect<string, PlanFailure>
