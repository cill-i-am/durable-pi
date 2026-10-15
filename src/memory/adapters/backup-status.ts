import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { BackupStatusRecord, type BackupStatusLedger } from "../backup-status"
import { MemoryStorageError } from "../domain"

/** SQLite owns physical status updates and last-complete-date retention. */
export class SqliteBackupStatus implements BackupStatusLedger {
  constructor(private readonly db: Sqlite) {
    this.write(() =>
      db.run(
        "CREATE TABLE IF NOT EXISTS memory_backup_status (id INTEGER PRIMARY KEY,date TEXT,watermark TEXT NOT NULL,error TEXT)"
      )
    )
  }
  private write(body: () => void) {
    try {
      body()
    } catch {
      throw new MemoryStorageError({ operation: "write backup status" })
    }
  }
  read() {
    let row: unknown
    try {
      row = this.db.all<unknown>(
        "SELECT date,watermark,error FROM memory_backup_status WHERE id=1"
      )[0]
    } catch {
      throw new MemoryStorageError({ operation: "read backup status" })
    }
    return row ? Schema.decodeUnknownSync(BackupStatusRecord)(row) : undefined
  }
  record(status: BackupStatusRecord) {
    this.write(() =>
      this.db.run(
        "INSERT INTO memory_backup_status VALUES (1,?,?,?) ON CONFLICT(id) DO UPDATE SET date=coalesce(excluded.date,memory_backup_status.date),watermark=excluded.watermark,error=excluded.error",
        status.date,
        status.watermark,
        status.error
      )
    )
  }
  fail(message: string) {
    this.write(() =>
      this.db.run(
        "INSERT INTO memory_backup_status VALUES (1,NULL,'',?) ON CONFLICT(id) DO UPDATE SET error=excluded.error",
        message
      )
    )
  }
}
