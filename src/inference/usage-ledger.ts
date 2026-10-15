import type {
  AccountUsage,
  Attempt,
  UsageReport,
  UsageTotals,
} from "./usage-domain"

/** Callbacks run synchronously in the native SQLite transaction. No Effect
 * runner or asynchronous work may escape the commit. */
export interface UsageLedger {
  atomic: <T>(body: () => T) => T
  insert: (attempt: Attempt) => void
  read: (id: string) => Attempt
  put: (attempt: Attempt) => void
  report: (report: UsageReport, at: string) => boolean
  running: () => readonly Attempt[]
  recent: () => readonly Attempt[]
  totals: (turnId: string) => UsageTotals
  accountTotals: () => AccountUsage
}
