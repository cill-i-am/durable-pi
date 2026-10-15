import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import type { ExecutionLedger } from "../ledger"
import { CodeRun, ExecutionStorageError, RunSummary } from "../contracts"

const Record = Schema.Struct({ record: Schema.String })
const Counts = Schema.Struct({ total: Schema.Int, running: Schema.Int })

export class ExecutionStore implements ExecutionLedger {
  constructor(private readonly db: Sqlite) {
    this.native(() =>
      db.run(
        "CREATE TABLE IF NOT EXISTS code_runs (id TEXT PRIMARY KEY,created INTEGER NOT NULL,record TEXT NOT NULL)"
      )
    )
  }
  private native<T>(body: () => T): T {
    try {
      return body()
    } catch {
      throw new ExecutionStorageError()
    }
  }
  atomic<T>(body: () => T): T {
    const callback: { failed: boolean; cause?: unknown } = { failed: false }
    try {
      return this.db.transaction(() => {
        try {
          return body()
        } catch (cause) {
          callback.failed = true
          callback.cause = cause
          throw cause
        }
      })
    } catch (cause) {
      if (callback.failed && cause === callback.cause) throw cause
      throw new ExecutionStorageError()
    }
  }
  private decode(row: unknown): CodeRun {
    return Schema.decodeUnknownSync(Schema.fromJsonString(CodeRun))(
      Schema.decodeUnknownSync(Record)(row).record
    )
  }
  get(id: string): CodeRun | undefined {
    const row = this.native(() =>
      this.db.all<unknown>("SELECT record FROM code_runs WHERE id=?", id)
    )[0]
    return row === undefined ? undefined : this.decode(row)
  }
  list() {
    return this.native(() =>
      this.db.all<unknown>(
        `SELECT id, json_extract(record,'$.label') AS label, json_extract(record,'$.status') AS status, created AS createdAt, json_extract(record,'$.finishedAt') AS finishedAt FROM code_runs ORDER BY created DESC,id DESC LIMIT 50`
      )
    ).map((row) => Schema.decodeUnknownSync(RunSummary)(row))
  }
  counts() {
    return Schema.decodeUnknownSync(Counts)(
      this.native(() =>
        this.db.all<unknown>(
          "SELECT count(*) AS total,coalesce(sum(json_extract(record,'$.status')='running'),0) AS running FROM code_runs"
        )
      )[0]
    )
  }
  running() {
    return this.native(() =>
      this.db.all<unknown>(
        "SELECT record FROM code_runs WHERE json_extract(record,'$.status')='running'"
      )
    ).map((row) => this.decode(row))
  }
  put(run: CodeRun) {
    const record = Schema.encodeSync(Schema.fromJsonString(CodeRun))(run)
    this.native(() =>
      this.db.run(
        "INSERT INTO code_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        run.id,
        run.createdAt,
        record
      )
    )
  }
}
