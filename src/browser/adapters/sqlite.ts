import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { browserApplication } from "../browser"
import type { BrowserDriver, BrowserUnavailable } from "../driver"
import type { BrowserRecord } from "../contracts"
import {
  BrowserRecordSchema,
  initialBrowser,
  resetBrowser,
  transferBrowser,
  updateBrowser,
} from "../domain"
import { BrowserStorageError, type BrowserRepository } from "../repository"

const Stored = Schema.Struct({ record: Schema.String })
const LegacyRecord = Schema.Struct({
  ...BrowserRecordSchema.fields,
  controller: Schema.optionalKey(BrowserRecordSchema.fields.controller),
  unrestricted: Schema.optionalKey(Schema.Boolean),
})
export class BrowserStore implements BrowserRepository {
  constructor(private readonly db: Sqlite) {
    this.native(() => {
      db.run(
        "CREATE TABLE IF NOT EXISTS bot_browser (id INTEGER PRIMARY KEY,record TEXT NOT NULL)"
      )
      db.run(
        "CREATE TABLE IF NOT EXISTS retired_browsers (id TEXT PRIMARY KEY)"
      )
    })
  }
  private native<T>(body: () => T): T {
    try {
      return body()
    } catch {
      throw new BrowserStorageError()
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
      throw new BrowserStorageError()
    }
  }
  read(): BrowserRecord {
    const row = this.native(() =>
      this.db.all<unknown>("SELECT record FROM bot_browser WHERE id=1")
    )[0]
    if (!row) return initialBrowser()
    const record = Schema.decodeUnknownSync(LegacyRecord)(
      JSON.parse(Schema.decodeUnknownSync(Stored)(row).record)
    )
    return {
      ...record,
      controller: record.controller ?? "agent",
      unrestricted: record.unrestricted ?? false,
    }
  }
  private write(value: BrowserRecord) {
    const encoded = JSON.stringify(value)
    this.native(() =>
      this.db.run(
        "INSERT INTO bot_browser VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
        encoded
      )
    )
  }
  update(
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) {
    return this.atomic(() => {
      const next = updateBrowser(this.read(), generation, patch)
      this.write(next)
      return next
    })
  }
  reset(generation: number, hosts: readonly string[], unrestricted = false) {
    return this.atomic(() => {
      const current = this.read(),
        next = resetBrowser(current, generation, hosts, unrestricted)
      if (current.session) this.retire(current.session.id)
      this.write(next)
      return next
    })
  }
  transfer(generation: number, controller: "agent" | "owner") {
    return this.atomic(() => {
      const next = transferBrowser(this.read(), generation, controller)
      this.write(next)
      return next
    })
  }
  retire(id: string) {
    this.native(() =>
      this.db.run("INSERT OR IGNORE INTO retired_browsers VALUES (?)", id)
    )
  }
  retired() {
    return this.native(() =>
      this.db.all<unknown>("SELECT id FROM retired_browsers")
    ).map(
      (row) =>
        Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(row).id
    )
  }
  forget(id: string) {
    this.native(() =>
      this.db.run("DELETE FROM retired_browsers WHERE id=?", id)
    )
  }
}

export const sqliteBrowserLayer = (
  db: Sqlite,
  driver: BrowserDriver,
  writable: () => boolean,
  wake: () => Effect.Effect<void, BrowserUnavailable>
) =>
  Layer.unwrap(
    Effect.try({
      try: () =>
        browserApplication(new BrowserStore(db), driver, writable, wake),
      catch: (cause) => {
        const browserStorageError =
          Schema.decodeUnknownOption(BrowserStorageError)(cause)
        if (browserStorageError._tag === "Some")
          return browserStorageError.value
        throw cause
      },
    })
  )
