import { Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { ResolvedRoute } from "../../inference/policy"
import { MemoryStorageError, NonNegativeInteger, Part } from "../domain"
import {
  SummaryRouteRecord,
  summaryOperationApplied,
  summaryRequestAllowed,
  summaryBudget,
  requireSummaryRevision,
  type SummaryRouteLedger,
} from "../routing"

export class SummaryRoutes implements SummaryRouteLedger {
  readonly transactionGroup: object
  constructor(private readonly db: Sqlite) {
    this.transactionGroup = db
    const native = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch {
        throw new MemoryStorageError({ operation })
      }
    }
    this.db = db = {
      all: (query, ...bindings) =>
        storage("read summary route", () => native.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write summary route", () => native.run(query, ...bindings)),
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
          throw new MemoryStorageError({
            operation: "summary route transaction",
          })
        }
      },
    }
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
  atomic<T>(body: () => T): T {
    return this.db.transaction(body)
  }
  private record(part: Part): SummaryRouteRecord | undefined {
    const row = this.db.all<
      Omit<SummaryRouteRecord, "route"> & { route: string }
    >(
      "SELECT * FROM summary_routes WHERE start=? AND count=? ORDER BY revision DESC LIMIT 1",
      part.start,
      part.count
    )[0]
    return row
      ? Schema.decodeUnknownSync(SummaryRouteRecord)({
          ...row,
          route: JSON.parse(row.route),
        })
      : undefined
  }
  revision(part: Part): number {
    const row = this.db.all<{ revision: number }>(
      "SELECT coalesce(max(revision),0) AS revision FROM summary_routes WHERE start=? AND count=?",
      part.start,
      part.count
    )[0]!
    return Schema.decodeUnknownSync(NonNegativeInteger)(row.revision)
  }
  current(part: Part): ResolvedRoute | undefined {
    return this.record(part)?.route
  }
  applied(operation: string, part: Part) {
    const row = this.db.all<{ start: number; count: number }>(
      "SELECT start,count FROM summary_routes WHERE operation=?",
      operation
    )[0]
    return summaryOperationApplied(
      row ? Schema.decodeUnknownSync(Part)(row) : undefined,
      part
    )
  }
  pin(part: Part, candidate: ResolvedRoute) {
    return this.db.transaction(
      () =>
        this.current(part) ?? this.replace(part, crypto.randomUUID(), candidate)
    )
  }
  budget(part: Part, contextWindow: number, expectedRevision?: number) {
    return this.db.transaction(() => {
      const current = this.record(part)
      requireSummaryRevision(current?.revision, expectedRevision)
      const budgeted = summaryBudget(current?.route, contextWindow)
      if (budgeted === current?.route) return budgeted
      this.db.run(
        "UPDATE summary_routes SET route=json_set(route,'$.contextWindow',?) WHERE start=? AND count=? AND revision=? AND json_extract(route,'$.contextWindow') IS NULL",
        contextWindow,
        part.start,
        part.count,
        current!.revision
      )
      return this.current(part)!
    })
  }
  beginRequest(part: Part, expectedRevision?: number) {
    return this.db.transaction(() => {
      const record = this.record(part)
      requireSummaryRevision(record?.revision, expectedRevision)
      if (!summaryRequestAllowed(record)) return false
      this.db.run(
        "UPDATE summary_routes SET requests=requests+1 WHERE start=? AND count=? AND revision=?",
        part.start,
        part.count,
        record!.revision
      )
      return true
    })
  }
  replace(part: Part, operation: string, candidate: ResolvedRoute) {
    return this.db.transaction(() => {
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
    })
  }
}
