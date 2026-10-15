import type { Sqlite } from "../../storage/sqlite"
import type { AgentProfile } from "../domain"
import { AgentStorageError } from "../domain"
import {
  AgentConfiguration,
  configurationChange,
  type ConfigurationLedger,
} from "../configuration"
import { Schema } from "effect"

export class BotConfigurationStore implements ConfigurationLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
    const native = db
    const storage = <T>(body: () => T): T => {
      try {
        return body()
      } catch {
        throw new AgentStorageError()
      }
    }
    this.db = db = {
      all: (query, ...bindings) =>
        storage(() => native.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage(() => native.run(query, ...bindings)),
      transaction: (body) => {
        const callback: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return native.transaction(() => {
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
          throw new AgentStorageError()
        }
      },
    }
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_configuration (id INTEGER PRIMARY KEY,owner TEXT NOT NULL,instructions TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_admission (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL)"
    )
  }

  read(): AgentConfiguration | undefined {
    const row = this.db.all(
      "SELECT owner,instructions,coalesce(revision,-1) AS revision,coalesce(status,'active') AS status FROM bot_configuration LEFT JOIN bot_admission USING(id) WHERE id=1"
    )[0]
    return row ? Schema.decodeUnknownSync(AgentConfiguration)(row) : undefined
  }

  configure(owner: string, profile: AgentProfile) {
    this.db.transaction(() => {
      const current = this.read()
      if (!configurationChange(current, owner, profile)) return
      this.db.run(
        "INSERT INTO bot_configuration VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET instructions=excluded.instructions",
        owner,
        profile.instructions
      )
      this.db.run(
        "INSERT INTO bot_admission VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,status=excluded.status",
        profile.revision,
        profile.status
      )
    })
  }
}
