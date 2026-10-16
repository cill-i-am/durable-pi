import type { Effect } from "effect"
import { Context, Layer, Schema } from "effect"

import type { MemoryStorageError } from "./domain"

export const BackupStatusRecord = Schema.Struct({
  date: Schema.NullOr(Schema.String),
  watermark: Schema.String,
  error: Schema.NullOr(Schema.String),
})
export type BackupStatusRecord = typeof BackupStatusRecord.Type
export interface BackupStatusLedger {
  read: () => Effect.Effect<BackupStatusRecord | undefined, MemoryStorageError>
  record: (
    status: BackupStatusRecord
  ) => Effect.Effect<void, MemoryStorageError>
  fail: (message: string) => Effect.Effect<void, MemoryStorageError>
}
export class MemoryBackupStatus extends Context.Service<
  MemoryBackupStatus,
  {
    read: () => Effect.Effect<
      BackupStatusRecord | undefined,
      MemoryStorageError
    >
    record: (
      status: BackupStatusRecord
    ) => Effect.Effect<void, MemoryStorageError>
    fail: (message: string) => Effect.Effect<void, MemoryStorageError>
  }
>()("durable-pi/memory/BackupStatus") {}
export const backupStatusApplication = (ledger: BackupStatusLedger) =>
  Layer.succeed(MemoryBackupStatus, {
    read: () => ledger.read(),
    record: (status) => ledger.record(status),
    fail: (message) => ledger.fail(message),
  })
