import { Clock, Effect, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import { backupMemory } from "./backup"
import { MemoryBackupStatus } from "./backup-status"
import type {
  BackupClaim,
  BackupRetry,
  BackupRecoveryLease,
} from "./backup.machine"
import {
  pumpSummaries,
  reconcileSummaryReceipts,
  summaryNextWake,
} from "./compaction"
import type { MemoryStorageError } from "./domain"
import { prepareHistory } from "./import"
import type { MemoryLedger } from "./ledger"
import { MemoryRepository } from "./repository"

export class MemoryImportBusy extends Schema.TaggedError<MemoryImportBusy>()(
  "MemoryImportBusy",
  {}
) {
  override get message() {
    return "Wait for the current reply before importing history."
  }
}
export class MemorySchedulingError extends Schema.TaggedError<MemorySchedulingError>()(
  "MemorySchedulingError",
  { operation: Schema.String }
) {}
export interface MemoryHost<TError, TRequirements = never> {
  active: () => Effect.Effect<boolean, TError, TRequirements>
  notify: () => Effect.Effect<void, TError, TRequirements>
  armCompactor: () => Effect.Effect<BackupRecoveryLease, TError, TRequirements>
  armBackup: () => Effect.Effect<BackupRecoveryLease, TError, TRequirements>
  wakeCompactor: () => Effect.Effect<void, TError, TRequirements>
  wakeBackup: () => Effect.Effect<void, TError, TRequirements>
  wakeConversation: () => Effect.Effect<void, TError, TRequirements>
}
export interface MemoryImportAuthority {
  readonly transactionGroup: object
  active: () => Effect.Effect<boolean, MemoryStorageError>
}

export const memoryReport = Effect.fn("Memory.report")(function* () {
  const memory = yield* MemoryRepository,
    status = yield* MemoryBackupStatus
  const messages = yield* memory.total(),
    summaries = yield* memory.nodeCount(),
    ready = yield* memory.settled(),
    notes = yield* memory.notes(),
    issues = yield* memory.issues(),
    backup = yield* status.read(),
    backupControl = yield* status.control()
  return {
    messages,
    summaries,
    ready,
    notes,
    issues,
    backup: {
      date: backup?.date ?? null,
      error: backup?.error ?? null,
      recovery:
        backupControl.phase === "failed" && backupControl.attemptId !== null
          ? { attemptId: backupControl.attemptId, target: backupControl.target }
          : null,
    },
  }
})
export const memoryTree = Effect.fn("Memory.tree")(function* (part?: {
  start: number
  count: number
}) {
  const memory = yield* MemoryRepository
  if (!part)
    return (yield* memory.snapshot()).view.map(
      ({ built: _built, ...item }) => ({
        ...item,
        text: item.text ?? "Not summarized yet",
      })
    )
  const text = yield* memory.zoom(part.start, part.count)
  const children =
    part.count > 1
      ? yield* Effect.forEach(
          [part.start, part.start + part.count / 2],
          (start) => memory.node({ start, count: part.count / 2 })
        )
      : []
  return {
    text,
    children,
    original: part.count === 1 ? yield* memory.entry(part.start) : null,
  }
})

export function memoryMaintenance<TError, TRequirements>(
  host: MemoryHost<TError, TRequirements>
) {
  return {
    reconcile: Effect.fn("Memory.reconcileSummaries")(function* () {
      const memory = yield* MemoryRepository
      yield* reconcileSummaryReceipts(memory)
      // The retained cleanup job owns these idempotent handoffs through their
      // acknowledgment, even when its prior publication already committed.
      yield* host.notify()
      yield* host.wakeBackup()
      if (yield* host.active()) yield* host.wakeConversation()
    }),
    nextWake: Effect.fn("Memory.summaryNextWake")(function* () {
      return yield* summaryNextWake(yield* MemoryRepository)
    }),
    compact: Effect.fn("Memory.runCompactor")(function* () {
      const next = yield* pumpSummaries()
      // A cold pump may resume after publication but before its handoff. Always
      // replay this idempotent wake; the backup watermark prevents new work.
      yield* host.notify()
      yield* host.wakeBackup()
      if (yield* host.active()) yield* host.wakeConversation()
      return next
    }),
    recover: Effect.fn("Memory.recoverMaintenance")(function* () {
      const memory = yield* MemoryRepository,
        status = yield* MemoryBackupStatus
      if ((yield* memory.next()) || (yield* memory.retryAt()) !== undefined)
        yield* host.wakeCompactor()
      if (
        (yield* memory.total()) &&
        (yield* status.read())?.watermark !==
          JSON.stringify(yield* memory.watermark())
      )
        yield* host.wakeBackup()
    }),
  }
}
export const runMemoryBackup = Effect.fn("Memory.runBackup")(function* (
  prefix: string,
  onClaim?: (claim: BackupClaim) => Effect.Effect<void, MemoryStorageError>
) {
  const memory = yield* MemoryRepository,
    status = yield* MemoryBackupStatus
  return yield* status.exclusive(
    Effect.gen(function* () {
      const before = JSON.stringify(yield* memory.watermark())
      const prior = yield* status.control()
      // The shared permit is held until the entire publication actor/native scope
      // joins, including across newly constructed service facades.
      if (prior.phase === "running")
        yield* status.transition({
          type: "RESTORE",
          now: yield* Clock.currentTimeMillis,
        })
      const attemptId = crypto.randomUUID()
      const claimed = yield* status.transition({
        type: "ADMIT",
        target: before,
        attemptId,
        now: yield* Clock.currentTimeMillis,
      })
      if (claimed.phase !== "running" || claimed.attemptId !== attemptId)
        return claimed.phase === "pending" ? claimed.retryAt : undefined
      if (onClaim)
        yield* onClaim({
          attemptId,
          target: claimed.target,
          attempts: claimed.attempts,
        })
      return yield* backupMemory(prefix).pipe(
        Effect.flatMap((result) =>
          Effect.gen(function* () {
            const next = yield* status.transition({
              type: "COMPLETE",
              attemptId,
              ...result,
              current: JSON.stringify(yield* memory.watermark()),
              now: yield* Clock.currentTimeMillis,
            })
            return next.phase === "pending" ? next.retryAt : undefined
          })
        ),
        preserveFatal,
        Effect.catchTag("BackupFailure", (failure) =>
          Effect.gen(function* () {
            const next = yield* status.transition({
              type: "FAILURE",
              attemptId,
              retryable:
                failure.reason === "transport" || failure.reason === "conflict",
              now: yield* Clock.currentTimeMillis,
            })
            return next.phase === "pending" ? next.retryAt : undefined
          })
        )
      )
    })
  )
})
export const restoreMemoryBackup = Effect.fn("Memory.restoreBackup")(
  function* () {
    const status = yield* MemoryBackupStatus
    yield* status
      .exclusive(
        status.transition({
          type: "RESTORE",
          now: yield* Clock.currentTimeMillis,
        })
      )
      .pipe(Effect.asVoid)
  }
)
export const retryMemoryBackup = Effect.fn("Memory.retryBackup")(function* (
  receipt: BackupRetry,
  lease: BackupRecoveryLease
) {
  const status = yield* MemoryBackupStatus
  const clock = yield* Clock.Clock
  return yield* status.exclusive(
    Effect.gen(function* () {
      const before = yield* status.control()
      if (
        before.phase !== "failed" ||
        before.attemptId !== receipt.attemptId ||
        before.target !== receipt.target
      )
        return false
      const next = yield* status.transition(
        { type: "RETRY", ...receipt, now: yield* Clock.currentTimeMillis },
        // Eligibility is evaluated inside the acquired SQL transaction.
        () =>
          lease.current() &&
          Number.isFinite(lease.deadline) &&
          lease.deadline > clock.currentTimeMillisUnsafe()
      )
      return next.phase === "pending" && next.attemptId === null
    })
  )
})
export const exhaustMemoryBackup = Effect.fn("Memory.exhaustBackup")(function* (
  claim: BackupClaim | undefined,
  current: () => boolean = () => true
) {
  if (!claim) return
  const status = yield* MemoryBackupStatus
  yield* status
    .exclusive(
      status.transition(
        { type: "EXHAUST", attemptId: claim.attemptId },
        current
      )
    )
    .pipe(Effect.asVoid)
})

/** Final import eligibility and publication share the native journal transaction.
 * Decoding/hashing precede it; persistence and wake acknowledgment cannot be split
 * by caller interruption after commitment. */
export function memoryImport<TError, TRequirements>(
  ledger: Pick<MemoryLedger, "transactionGroup" | "atomic" | "importEntries">,
  authority: MemoryImportAuthority,
  host: Pick<
    MemoryHost<TError, TRequirements>,
    "wakeCompactor" | "wakeBackup" | "armCompactor" | "armBackup"
  >
) {
  if (ledger.transactionGroup !== authority.transactionGroup)
    throw new Error(
      "Memory import authority must share its native transaction group"
    )
  const publish = (
    id: string,
    records: Parameters<MemoryLedger["importEntries"]>[1],
    leases: readonly BackupRecoveryLease[]
  ) =>
    ledger.atomic(() =>
      Effect.gen(function* () {
        if (yield* authority.active()) return yield* new MemoryImportBusy()
        const now = yield* Clock.currentTimeMillis
        if (
          !leases.every(
            (lease) =>
              Number.isFinite(lease.deadline) &&
              lease.deadline > now &&
              lease.current()
          )
        )
          return yield* new MemorySchedulingError({
            operation: "retain import maintenance",
          })
        return yield* ledger.importEntries(id, records)
      })
    )
  return Effect.fn("Memory.importCommand")(function* (jsonl: string) {
    if (yield* authority.active()) return yield* new MemoryImportBusy()
    const prepared = yield* prepareHistory(jsonl)
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const leases = [yield* host.armCompactor(), yield* host.armBackup()]
        const added = yield* publish(prepared.id, prepared.records, leases)
        yield* host.wakeCompactor()
        yield* host.wakeBackup()
        return { added }
      })
    )
  })
}
