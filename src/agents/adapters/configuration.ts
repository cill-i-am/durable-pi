import type { Sqlite } from "../../storage/sqlite"
import type { AgentProfile } from "../domain"

type Configuration = Pick<
  AgentProfile,
  "instructions" | "revision" | "status"
> & { owner: string }

export class BotConfigurationStore {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_configuration (id INTEGER PRIMARY KEY,owner TEXT NOT NULL,instructions TEXT NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS bot_admission (id INTEGER PRIMARY KEY,revision INTEGER NOT NULL,status TEXT NOT NULL)"
    )
  }

  read(): Configuration | undefined {
    return this.db.all<Configuration>(
      "SELECT owner,instructions,coalesce(revision,-1) AS revision,coalesce(status,'active') AS status FROM bot_configuration LEFT JOIN bot_admission USING(id) WHERE id=1"
    )[0]
  }

  configure(owner: string, profile: AgentProfile) {
    this.db.transaction(() => {
      const current = this.read()
      if (current && current.owner !== owner) throw new Error("Owner mismatch")
      if (current && current.revision >= profile.revision) return
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
