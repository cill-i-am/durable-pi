import type { Effect } from "effect"

import type {
  AccountUsage,
  Attempt,
  UsageReport,
  UsageTotals,
  UsageStorageError,
} from "./usage-domain"

/** Related attempt and account usage writes share one actor transaction. */
export interface UsageLedger {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | UsageStorageError, TRequirements>
  insert: (attempt: Attempt) => Effect.Effect<void, UsageStorageError>
  read: (id: string) => Effect.Effect<Attempt, UsageStorageError>
  put: (attempt: Attempt) => Effect.Effect<void, UsageStorageError>
  report: (
    report: UsageReport,
    at: string
  ) => Effect.Effect<boolean, UsageStorageError>
  running: () => Effect.Effect<readonly Attempt[], UsageStorageError>
  recent: () => Effect.Effect<readonly Attempt[], UsageStorageError>
  totals: (turnId: string) => Effect.Effect<UsageTotals, UsageStorageError>
  accountTotals: () => Effect.Effect<AccountUsage, UsageStorageError>
}
