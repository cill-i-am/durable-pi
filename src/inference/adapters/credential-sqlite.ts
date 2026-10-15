import { Redacted, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import {
  CredentialCorrupt,
  CredentialStorageError,
  ModelCredential,
  type CredentialLedger,
} from "../credentials"

const Row = Schema.Struct({
  value: Schema.String,
  seed: Schema.String,
  refreshing: Schema.Int,
})
const JsonCredential = Schema.fromJsonString(ModelCredential)
export class SqliteCredentials implements CredentialLedger {
  constructor(
    private readonly db: Sqlite,
    private readonly deploymentSeed: Redacted.Redacted<string>
  ) {
    this.native(() =>
      db.run(
        "CREATE TABLE IF NOT EXISTS model_credentials (provider TEXT PRIMARY KEY, value TEXT NOT NULL, seed TEXT NOT NULL)"
      )
    )
    this.native(() =>
      db.run(
        "CREATE TABLE IF NOT EXISTS model_credential_refresh (provider TEXT PRIMARY KEY)"
      )
    )
  }
  private native<T>(body: () => T): T {
    try {
      return body()
    } catch {
      throw new CredentialStorageError()
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
      throw new CredentialStorageError()
    }
  }
  private decode(value: string) {
    try {
      return Schema.decodeUnknownSync(JsonCredential)(value)
    } catch {
      throw new CredentialCorrupt()
    }
  }
  read(provider: string) {
    const raw = this.native(() =>
      this.db.all<unknown>(
        "SELECT value,seed,EXISTS(SELECT 1 FROM model_credential_refresh WHERE provider=?) AS refreshing FROM model_credentials WHERE provider=?",
        provider,
        provider
      )
    )[0]
    if (raw === undefined) return undefined
    let row: typeof Row.Type
    try {
      row = Schema.decodeUnknownSync(Row)(raw)
    } catch {
      throw new CredentialCorrupt()
    }
    const seed = Redacted.value(this.deploymentSeed)
    const refreshing = row.refreshing !== 0
    if (seed && row.seed !== seed)
      return { seedCurrent: false as const, refreshing }
    return {
      value: this.decode(row.value),
      seedCurrent: true as const,
      refreshing,
    }
  }
  seed() {
    const seed = Redacted.value(this.deploymentSeed)
    return seed ? this.decode(seed) : undefined
  }
  put(provider: string, value: ModelCredential) {
    let encoded: string
    try {
      encoded = Schema.encodeSync(JsonCredential)(value)
    } catch {
      throw new CredentialCorrupt()
    }
    this.native(() =>
      this.db.run(
        "INSERT INTO model_credentials VALUES (?,?,?) ON CONFLICT(provider) DO UPDATE SET value=excluded.value,seed=excluded.seed",
        provider,
        encoded,
        Redacted.value(this.deploymentSeed)
      )
    )
  }
  claim(provider: string, active: boolean) {
    this.native(() =>
      active
        ? this.db.run(
            "INSERT INTO model_credential_refresh VALUES (?)",
            provider
          )
        : this.db.run(
            "DELETE FROM model_credential_refresh WHERE provider=?",
            provider
          )
    )
  }
}
