import type { Sqlite } from "../../storage/sqlite"
import { BrowserFailure, type BrowserRecord } from "../contracts"
import type { BrowserRepository } from "../browser"

export class BrowserStore implements BrowserRepository {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_browser (id INTEGER PRIMARY KEY,record TEXT NOT NULL)"
    )
    db.run("CREATE TABLE IF NOT EXISTS retired_browsers (id TEXT PRIMARY KEY)")
  }
  read(): BrowserRecord {
    const row = this.db.all<{ record: string }>(
      "SELECT record FROM bot_browser WHERE id=1"
    )[0]
    return row
      ? ({
          controller: "agent",
          unrestricted: false,
          ...JSON.parse(row.record),
        } as BrowserRecord)
      : {
          controller: "agent",
          generation: 0,
          hosts: [],
          unrestricted: true,
          version: 0,
          status: "closed",
          session: null,
          capture: null,
          error: null,
        }
  }
  private put(value: BrowserRecord) {
    this.db.run(
      "INSERT INTO bot_browser VALUES (1,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record",
      JSON.stringify(value)
    )
    return value
  }
  update(
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) {
    return this.db.transaction(() => {
      const value = this.read()
      if (value.generation !== generation)
        throw new BrowserFailure({
          message: "Browser settings changed. Reload before continuing.",
        })
      return this.put({ ...value, ...patch, version: value.version + 1 })
    })
  }
  reset(generation: number, hosts: readonly string[], unrestricted = false) {
    return this.db.transaction(() => {
      const value = this.read()
      if (value.generation !== generation)
        throw new BrowserFailure({
          message: "Browser settings changed. Reload before continuing.",
        })
      if (value.session) this.retire(value.session.id)
      return this.put({
        controller: "agent",
        generation: generation + 1,
        hosts,
        unrestricted,
        version: value.version + 1,
        status: "closed",
        session: null,
        capture: null,
        error: null,
      })
    })
  }
  transfer(generation: number, controller: "agent" | "owner") {
    return this.db.transaction(() => {
      const value = this.read()
      if (value.generation !== generation)
        throw new BrowserFailure({
          message: "Browser control changed. Reload before continuing.",
        })
      return this.put({
        ...value,
        controller,
        generation: generation + 1,
        version: value.version + 1,
        status: "loading",
        capture: null,
        error: null,
      })
    })
  }
  retire(id: string) {
    this.db.run("INSERT OR IGNORE INTO retired_browsers VALUES (?)", id)
  }
  retired() {
    return this.db
      .all<{ id: string }>("SELECT id FROM retired_browsers")
      .map((row) => row.id)
  }
  forget(id: string) {
    this.db.run("DELETE FROM retired_browsers WHERE id=?", id)
  }
}
