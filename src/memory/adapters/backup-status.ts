import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { mapSqliteError, type Sqlite } from "../../storage/sqlite"
import { coalesce } from "../../storage/expressions"
import { BackupStatusRecord, type BackupStatusLedger } from "../backup-status"
import { MemoryStorageError } from "../domain"
import { memoryBackupStatus } from "./schema"

export class SqliteBackupStatus implements BackupStatusLedger {
  constructor(private readonly db: Sqlite) {}
  read(): ReturnType<BackupStatusLedger["read"]> {
    return mapSqliteError(
      this.db.use((orm) =>
        orm
          .select({
            date: memoryBackupStatus.date,
            watermark: memoryBackupStatus.watermark,
            error: memoryBackupStatus.error,
          })
          .from(memoryBackupStatus)
          .where(eq(memoryBackupStatus.id, 1))
          .limit(1)
      ),
      () => new MemoryStorageError({ operation: "read backup status" })
    ).pipe(
      Effect.map((rows) =>
        rows[0]
          ? Schema.decodeUnknownSync(BackupStatusRecord)(rows[0])
          : undefined
      )
    )
  }
  record(status: BackupStatusRecord): ReturnType<BackupStatusLedger["record"]> {
    return mapSqliteError(
      this.db.use((orm) =>
        orm
          .insert(memoryBackupStatus)
          .values({ id: 1, ...status })
          .onConflictDoUpdate({
            target: memoryBackupStatus.id,
            set: {
              ...status,
              date: coalesce(status.date, memoryBackupStatus.date),
            },
          })
      ),
      () => new MemoryStorageError({ operation: "write backup status" })
    ).pipe(Effect.asVoid)
  }
  fail(message: string): ReturnType<BackupStatusLedger["fail"]> {
    return mapSqliteError(
      this.db.use((orm) =>
        orm
          .insert(memoryBackupStatus)
          .values({ id: 1, date: null, watermark: "", error: message })
          .onConflictDoUpdate({
            target: memoryBackupStatus.id,
            set: { error: message },
          })
      ),
      () => new MemoryStorageError({ operation: "write backup status" })
    ).pipe(Effect.asVoid)
  }
}
