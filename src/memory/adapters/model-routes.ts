import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { ResolvedRoute } from "../../inference/policy"
import { InvalidMemory, type Part } from "../domain"

/** Model selection for one immutable summary range. Memory remains the owner of source and result. */
export class SummaryRoutes {
  constructor(private readonly db: Sqlite) {
    db.run(
      "CREATE TABLE IF NOT EXISTS summary_routes (start INTEGER NOT NULL,count INTEGER NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL UNIQUE,route TEXT NOT NULL,PRIMARY KEY(start,count,revision))"
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(summary_routes)")
        .some((column) => column.name === "requests")
    )
      db.run(
        "ALTER TABLE summary_routes ADD COLUMN requests INTEGER NOT NULL DEFAULT 0"
      )
  }
  revision(part: Part): number {
    return this.db.all<{ revision: number }>(
      "SELECT coalesce(max(revision),0) AS revision FROM summary_routes WHERE start=? AND count=?",
      part.start,
      part.count
    )[0]!.revision
  }
  current(part: Part): ResolvedRoute | undefined {
    const row = this.db.all<{ route: string }>(
      "SELECT route FROM summary_routes WHERE start=? AND count=? ORDER BY revision DESC LIMIT 1",
      part.start,
      part.count
    )[0]
    return row
      ? Schema.decodeUnknownSync(ResolvedRoute)(JSON.parse(row.route))
      : undefined
  }
  applied(operation: string, part: Part) {
    const prior = this.db.all<{ start: number; count: number }>(
      "SELECT start,count FROM summary_routes WHERE operation=?",
      operation
    )[0]
    if (prior && (prior.start !== part.start || prior.count !== part.count))
      throw new InvalidMemory({
        message: "This retry identifier belongs to another summary.",
      })
    return !!prior
  }
  pin(part: Part, candidate: ResolvedRoute) {
    return (
      this.current(part) ?? this.replace(part, crypto.randomUUID(), candidate)
    )
  }
  budget(part: Part, contextWindow: number) {
    this.db.run(
      "UPDATE summary_routes SET route=json_set(route,'$.contextWindow',?) WHERE start=? AND count=? AND revision=(SELECT max(revision) FROM summary_routes WHERE start=? AND count=?) AND json_extract(route,'$.contextWindow') IS NULL",
      contextWindow,
      part.start,
      part.count,
      part.start,
      part.count
    )
    return this.current(part)!
  }
  /** Count dispatch intent before I/O so repeated runtime interruption cannot create unlimited requests. */
  beginRequest(part: Part) {
    const row = this.db.all<{ revision: number; requests: number }>(
      "SELECT revision,requests FROM summary_routes WHERE start=? AND count=? ORDER BY revision DESC LIMIT 1",
      part.start,
      part.count
    )[0]
    if (!row || row.requests >= 15) return false
    this.db.run(
      "UPDATE summary_routes SET requests=requests+1 WHERE start=? AND count=? AND revision=?",
      part.start,
      part.count,
      row.revision
    )
    return true
  }
  /** Explicit owner retry creates a revision; ordinary restarts never change the pin. */
  replace(part: Part, operation: string, candidate: ResolvedRoute) {
    this.applied(operation, part)
    const prior = this.db.all<{ route: string }>(
      "SELECT route FROM summary_routes WHERE operation=?",
      operation
    )[0]
    if (prior)
      return Schema.decodeUnknownSync(ResolvedRoute)(JSON.parse(prior.route))
    this.db.run(
      "INSERT INTO summary_routes(start,count,revision,operation,route) SELECT ?,?,coalesce(max(revision),0)+1,?,? FROM summary_routes WHERE start=? AND count=?",
      part.start,
      part.count,
      operation,
      JSON.stringify(candidate),
      part.start,
      part.count
    )
    return candidate
  }
}
