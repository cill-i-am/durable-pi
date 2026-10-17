import { Clock, Effect, Schema } from "effect"

import { preserveFatal } from "../shared/effect"
import { backupMemory } from "./backup"
import { MemoryBackupStatus } from "./backup-status"
import { pumpSummaries } from "./compaction"
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
    backup = yield* status.read()
  return {
    messages,
    summaries,
    ready,
    notes,
    issues,
    backup: { date: backup?.date ?? null, error: backup?.error ?? null },
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
    compact: Effect.fn("Memory.runCompactor")(function* () {
      const memory = yield* MemoryRepository
      const before = JSON.stringify(yield* memory.watermark())
      const next = yield* pumpSummaries()
      yield* host.notify()
      if (before !== JSON.stringify(yield* memory.watermark()))
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
  prefix: string
) {
  const memory = yield* MemoryRepository,
    status = yield* MemoryBackupStatus
  const before = JSON.stringify(yield* memory.watermark())
  if ((yield* status.read())?.watermark === before) return
  return yield* backupMemory(prefix).pipe(
    Effect.flatMap((result) =>
      Effect.gen(function* () {
        yield* status.record({
          date: result.pending ? null : result.date,
          watermark: result.pending ? "" : before,
          error: result.pending ? "Backup in progress" : null,
        })
        return result.pending ||
          before !== JSON.stringify(yield* memory.watermark())
          ? (yield* Clock.currentTimeMillis) + 100
          : undefined
      })
    ),
    preserveFatal,
    Effect.catchTag("BackupFailure", () =>
      Effect.gen(function* () {
        yield* status.fail("Backup pending; retrying")
        return (yield* Clock.currentTimeMillis) + 10_000
      })
    )
  )
})

/** Final import eligibility and publication share the native journal transaction.
 * Decoding/hashing precede it; persistence and wake acknowledgment cannot be split
 * by caller interruption after commitment. */
export function memoryImport<TError, TRequirements>(
  ledger: Pick<MemoryLedger, "transactionGroup" | "atomic" | "importEntries">,
  authority: MemoryImportAuthority,
  host: Pick<MemoryHost<TError, TRequirements>, "wakeCompactor" | "wakeBackup">
) {
  if (ledger.transactionGroup !== authority.transactionGroup)
    throw new Error(
      "Memory import authority must share its native transaction group"
    )
  const publish = (
    id: string,
    records: Parameters<MemoryLedger["importEntries"]>[1]
  ) =>
    ledger.atomic(() =>
      Effect.gen(function* () {
        if (yield* authority.active()) return yield* new MemoryImportBusy()
        return yield* ledger.importEntries(id, records)
      })
    )
  return Effect.fn("Memory.importCommand")(function* (jsonl: string) {
    if (yield* authority.active()) return yield* new MemoryImportBusy()
    const prepared = yield* prepareHistory(jsonl)
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const added = yield* publish(prepared.id, prepared.records)
        yield* host.wakeCompactor()
        yield* host.wakeBackup()
        return { added }
      })
    )
  })
}
