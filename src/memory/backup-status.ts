import { Context, Effect, Layer, Schema } from "effect"
import { MemoryStorageError } from "./domain"

export const BackupStatusRecord = Schema.Struct({
  date: Schema.NullOr(Schema.String),
  watermark: Schema.String,
  error: Schema.NullOr(Schema.String),
})
export type BackupStatusRecord = typeof BackupStatusRecord.Type
export interface BackupStatusLedger {
  read: () => BackupStatusRecord | undefined
  record: (status: BackupStatusRecord) => void
  fail: (message: string) => void
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
const call = <T>(operation: string, body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const memoryStorageError =
        Schema.decodeUnknownOption(MemoryStorageError)(cause)
      if (memoryStorageError._tag === "Some") return memoryStorageError.value
      throw cause
    },
  }).pipe(Effect.withSpan(`Memory.backupStatus.${operation}`))
export const backupStatusApplication = (ledger: BackupStatusLedger) =>
  Layer.succeed(MemoryBackupStatus, {
    read: () => call("read", () => ledger.read()),
    record: (status) => call("record", () => ledger.record(status)),
    fail: (message) => call("fail", () => ledger.fail(message)),
  })
