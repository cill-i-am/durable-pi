import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import {
  AccountUsage,
  Attempt,
  UsageStorageError,
  UsageTotals,
  type UsageReport,
} from "../usage-domain"
import type { UsageLedger } from "../usage-ledger"

const Row = Schema.Struct({ id: Schema.String, payload: Schema.String })
const JsonAttempt = Schema.fromJsonString(Attempt)
const decode = (raw: unknown): Attempt => {
  const row = Schema.decodeUnknownSync(Row)(raw)
  const attempt = Schema.decodeUnknownSync(JsonAttempt)(row.payload)
  if (attempt.id !== row.id)
    throw new Error("Stored inference attempt identity does not match its key.")
  return attempt
}

export class SqliteUsage implements UsageLedger {
  constructor(private readonly db: Sqlite) {
    this.native("initialize", () => {
      db.run(
        "CREATE TABLE IF NOT EXISTS inference_attempts (id TEXT PRIMARY KEY,payload TEXT NOT NULL)"
      )
      db.run(
        "CREATE INDEX IF NOT EXISTS inference_attempts_run ON inference_attempts(json_extract(payload,'$.turnId'))"
      )
      db.run(
        "CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY,model TEXT NOT NULL,input INTEGER NOT NULL,cached INTEGER NOT NULL,output INTEGER NOT NULL,date TEXT NOT NULL)"
      )
    })
  }
  private native<T>(operation: string, body: () => T): T {
    try {
      return body()
    } catch {
      throw new UsageStorageError({ operation })
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
      throw new UsageStorageError({ operation: "commit" })
    }
  }
  insert(attempt: Attempt) {
    const payload = Schema.encodeSync(JsonAttempt)(attempt)
    this.native("start", () =>
      this.db.run(
        "INSERT INTO inference_attempts VALUES (?,?)",
        attempt.id,
        payload
      )
    )
  }
  read(id: string) {
    const row = this.native("read", () =>
      this.db.all<unknown>(
        "SELECT id,payload FROM inference_attempts WHERE id=?",
        id
      )
    )[0]
    return decode(row)
  }
  put(attempt: Attempt) {
    const payload = Schema.encodeSync(JsonAttempt)(attempt)
    this.native("update", () =>
      this.db.run(
        "UPDATE inference_attempts SET payload=? WHERE id=?",
        payload,
        attempt.id
      )
    )
  }
  report(report: UsageReport, at: string) {
    const row = this.native("report", () => {
      this.db.run(
        "INSERT OR IGNORE INTO model_usage VALUES (?,?,?,?,?,?)",
        report.id,
        report.model,
        report.input,
        report.cached,
        report.output,
        at
      )
      return this.db.all<unknown>("SELECT changes() AS count")[0]
    })
    return (
      Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Int }))(row)
        .count !== 0
    )
  }
  running() {
    return this.native("recover", () =>
      this.db.all<unknown>(
        "SELECT id,payload FROM inference_attempts WHERE json_extract(payload,'$.outcome')='running'"
      )
    ).map(decode)
  }
  recent() {
    return this.native("recent", () =>
      this.db.all<unknown>(
        "SELECT id,payload FROM inference_attempts ORDER BY rowid DESC LIMIT 100"
      )
    ).map(decode)
  }
  totals(turnId: string) {
    const row = this.native("totals", () =>
      this.db.all<unknown>(
        `SELECT count(*) AS modelRequests,
        count(CASE WHEN json_extract(payload,'$.input') IS NOT NULL
          AND json_extract(payload,'$.cached') IS NOT NULL
          AND json_extract(payload,'$.output') IS NOT NULL THEN 1 END) AS usageReportedRequests,
        coalesce(sum(json_extract(payload,'$.input')),0) AS knownInputTokens,
        coalesce(sum(json_extract(payload,'$.cached')),0) AS knownCachedInputTokens,
        coalesce(sum(json_extract(payload,'$.output')),0) AS knownOutputTokens
       FROM inference_attempts WHERE json_extract(payload,'$.turnId')=?`,
        turnId
      )
    )[0]
    return Schema.decodeUnknownSync(UsageTotals)(row)
  }
  accountTotals() {
    const row = this.native("account totals", () =>
      this.db.all<unknown>(
        "SELECT coalesce(sum(input),0) AS input,coalesce(sum(cached),0) AS cached,coalesce(sum(output),0) AS output,count(*) AS requests FROM model_usage"
      )
    )[0]
    return Schema.decodeUnknownSync(AccountUsage)(row)
  }
}
