import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"

import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { BackupStatusRecord, type BackupStatusLedger } from "../backup-status"
import {
  BackupControl,
  decideBackup,
  initialBackupControl,
  type BackupEvent,
} from "../backup.machine"
import { MemoryStorageError } from "../domain"
import { memoryBackupStatus } from "./schema"

export class SqliteBackupStatus implements BackupStatusLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
  }
  private raw() {
    return this.db.use((orm) =>
      orm
        .select()
        .from(memoryBackupStatus)
        .where(eq(memoryBackupStatus.id, 1))
        .limit(1)
    )
  }
  read(): ReturnType<BackupStatusLedger["read"]> {
    return mapSqliteError(
      this.raw(),
      () => new MemoryStorageError({ operation: "read backup status" })
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(BackupStatusRecord)(rows[0])
          : undefined
      )
    )
  }
  private save(state: BackupControl) {
    return this.db.use((orm) =>
      orm
        .insert(memoryBackupStatus)
        .values({ id: 1, ...state })
        .onConflictDoUpdate({ target: memoryBackupStatus.id, set: state })
    )
  }
  private load() {
    return Effect.gen({ self: this }, function* () {
      const row = (yield* this.raw())[0]
      if (!row) return initialBackupControl()
      if (row.schemaVersion === 0 && row.workflowVersion === 0) {
        const converted = initialBackupControl(
          Schema.decodeUnknownSync(BackupStatusRecord)(row)
        )
        yield* this.save(converted)
        return converted
      }
      return Schema.decodeUnknownSync(BackupControl)(row)
    })
  }
  control(): ReturnType<BackupStatusLedger["control"]> {
    return mapSqliteError(
      this.db.transaction(() => this.load()),
      () => new MemoryStorageError({ operation: "read backup control" })
    )
  }
  transition(
    event: BackupEvent,
    current: () => boolean = () => true
  ): ReturnType<BackupStatusLedger["transition"]> {
    return mapSqliteError(
      this.db.transaction(() =>
        Effect.gen({ self: this }, function* () {
          const state = yield* this.load()
          if (!current()) return state
          const next = decideBackup(state, event)
          yield* this.save(next)
          return next
        })
      ),
      () => new MemoryStorageError({ operation: "write backup status" })
    )
  }
  record(status: BackupStatusRecord): ReturnType<BackupStatusLedger["record"]> {
    return this.transition({ type: "RECORD", ...status }).pipe(Effect.asVoid)
  }
  fail(message: string): ReturnType<BackupStatusLedger["fail"]> {
    return this.transition({ type: "REPORT", message }).pipe(Effect.asVoid)
  }
}
