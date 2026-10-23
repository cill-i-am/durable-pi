import { Context, Layer, Semaphore, type Effect } from "effect"

import {
  BackupStatusRecord,
  type BackupControl,
  type BackupEvent,
} from "./backup.machine"
import type { MemoryStorageError } from "./domain"
export { BackupStatusRecord } from "./backup.machine"
export type BackupStatusRecord = typeof BackupStatusRecord.Type
export interface BackupStatusLedger {
  readonly transactionGroup: object
  read: () => Effect.Effect<BackupStatusRecord | undefined, MemoryStorageError>
  record: (
    status: BackupStatusRecord
  ) => Effect.Effect<void, MemoryStorageError>
  fail: (message: string) => Effect.Effect<void, MemoryStorageError>
  control: () => Effect.Effect<BackupControl, MemoryStorageError>
  transition: (
    event: BackupEvent,
    current?: () => boolean
  ) => Effect.Effect<BackupControl, MemoryStorageError>
}
const owners = new WeakMap<object, Semaphore.Semaphore>()
export class MemoryBackupStatus extends Context.Service<
  MemoryBackupStatus,
  Omit<BackupStatusLedger, "transactionGroup"> & {
    exclusive: <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  }
>()("durable-pi/memory/BackupStatus") {}
export const backupStatusApplication = (ledger: BackupStatusLedger) => {
  let owner = owners.get(ledger.transactionGroup)
  if (!owner) {
    owner = Semaphore.makeUnsafe(1)
    owners.set(ledger.transactionGroup, owner)
  }
  return Layer.succeed(MemoryBackupStatus, {
    read: () => ledger.read(),
    record: (status) => ledger.record(status),
    fail: (message) => ledger.fail(message),
    control: () => ledger.control(),
    transition: (event, current) => ledger.transition(event, current),
    exclusive: owner.withPermits(1),
  })
}
