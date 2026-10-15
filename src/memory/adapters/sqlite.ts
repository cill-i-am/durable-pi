import { Effect, Layer, Schema } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { makeMemoryRepository, memoryApplication } from "../service"
import * as Policy from "../policy"
import { MemoryTransaction, type MemoryLedger } from "../ledger"
import {
  nodeKey,
  VIEW_BYTES,
  InvalidMemory,
  MemoryStorageError,
  LogEntry,
  type LogKind,
  type MemoryNode,
  type Part,
  type SummaryJob,
} from "../domain"
import {
  type ArchiveRecord,
  type MessageRecord,
  type NodeRecord,
  type NoteRecord,
  type Watermark,
  StoredPart,
  StoredNode,
  StoredFailure,
  StoredMerge,
  StoredCount,
  StoredViewState,
  StoredNote,
  StoredIssue,
  StoredArchiveRecord,
} from "../records"

class SqliteMemory implements MemoryLedger {
  readonly transactionGroup: object
  constructor(
    readonly db: Sqlite,
    readonly budget = VIEW_BYTES
  ) {
    this.transactionGroup = db
    const nativeDb = db
    const storage = <T>(operation: string, body: () => T): T => {
      try {
        return body()
      } catch {
        throw new MemoryStorageError({ operation })
      }
    }
    this.db = db = {
      all: (query, ...bindings) =>
        storage("read", () => nativeDb.all(query, ...bindings)),
      run: (query, ...bindings) =>
        storage("write", () => nativeDb.run(query, ...bindings)),
      transaction: (body) => {
        const callback: { failed: boolean; cause?: unknown } = { failed: false }
        try {
          return nativeDb.transaction(() => {
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
          throw new MemoryStorageError({ operation: "transaction" })
        }
      },
    }
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_log (id INTEGER PRIMARY KEY, source TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, text TEXT NOT NULL, date TEXT NOT NULL)`
    )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_nodes (start INTEGER NOT NULL, count INTEGER NOT NULL, text TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(start,count))`
    )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_view (start INTEGER PRIMARY KEY, count INTEGER NOT NULL)`
    )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_failures (start INTEGER NOT NULL, count INTEGER NOT NULL, retry_at INTEGER NOT NULL, PRIMARY KEY(start,count))`
    )
    if (
      !db
        .all<{ name: string }>("PRAGMA table_info(memory_failures)")
        .some((column) => column.name === "attempts")
    )
      db.run(
        "ALTER TABLE memory_failures ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1"
      )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_notes (path TEXT PRIMARY KEY, body TEXT NOT NULL, source_id INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(source_id) REFERENCES memory_log(id))`
    )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_note_history (id INTEGER PRIMARY KEY, path TEXT NOT NULL, body TEXT NOT NULL, source_id INTEGER NOT NULL, date TEXT NOT NULL)`
    )

    db.run(
      "CREATE TABLE IF NOT EXISTS memory_view_state (id INTEGER PRIMARY KEY, compacting INTEGER NOT NULL)"
    )
    db.run("INSERT OR IGNORE INTO memory_view_state VALUES (1,0)")
    db.run(
      "CREATE TABLE IF NOT EXISTS memory_compaction_view (start INTEGER PRIMARY KEY, count INTEGER NOT NULL)"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS memory_ready (start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(count,start))"
    )
    db.run(
      "CREATE TABLE IF NOT EXISTS memory_migrations (name TEXT PRIMARY KEY)"
    )
    db.transaction(() => {
      if (
        db.all("SELECT 1 FROM memory_migrations WHERE name='effect-memory-v1'")
          .length
      )
        return
      db.run(
        "INSERT OR IGNORE INTO memory_ready SELECT l.id,1 FROM memory_log l LEFT JOIN memory_nodes n ON n.start=l.id AND n.count=1 WHERE n.start IS NULL"
      )
      db.run(
        "INSERT OR IGNORE INTO memory_ready SELECT a.start,a.count*2 FROM memory_nodes a JOIN memory_nodes b ON b.start=a.start+a.count AND b.count=a.count LEFT JOIN memory_nodes p ON p.start=a.start AND p.count=a.count*2 WHERE a.start%(a.count*2)=0 AND p.start IS NULL"
      )
      db.run("INSERT INTO memory_compaction_view SELECT * FROM memory_view")
      db.run("INSERT OR IGNORE INTO memory_view_state VALUES (2,1)")
      db.run("INSERT INTO memory_migrations VALUES ('effect-memory-v1')")
    })
  }

  private rows<T>(
    schema: Schema.ConstraintDecoder<T, never>,
    query: string,
    ...bindings: (string | number | null)[]
  ): T[] {
    return this.db
      .all<unknown>(query, ...bindings)
      .map((row) => Schema.decodeUnknownSync(schema)(row))
  }
  private row<T>(
    schema: Schema.ConstraintDecoder<T, never>,
    query: string,
    ...bindings: (string | number | null)[]
  ): T | undefined {
    return this.rows(schema, query, ...bindings)[0]
  }
  atomic<T>(body: () => T): T {
    return this.db.transaction(body)
  }
  append(source: string, kind: LogKind, text: string, date: string): LogEntry {
    return this.db.transaction(() => {
      const prior = this.row(
        LogEntry,
        "SELECT * FROM memory_log WHERE source = ?",
        source
      )
      if (prior) return prior
      const id = this.total()
      const entry = Schema.decodeUnknownSync(LogEntry)({
        id,
        source,
        kind,
        text,
        date,
      })
      this.db.run(
        "INSERT INTO memory_log VALUES (?,?,?,?,?)",
        id,
        source,
        kind,
        text,
        date
      )
      this.db.run("INSERT INTO memory_view VALUES (?,1)", id)
      this.db.run("INSERT INTO memory_compaction_view VALUES (?,1)", id)
      this.db.run("INSERT INTO memory_ready VALUES (?,1)", id)
      this.fitViews()
      return entry
    })
  }
  total() {
    return this.row(
      StoredCount,
      "SELECT coalesce(max(id)+1,0) AS n FROM memory_log"
    )!.n
  }
  parts() {
    return this.rows(StoredPart, "SELECT * FROM memory_view ORDER BY start")
  }
  node(part: Part) {
    return this.row(
      StoredNode,
      "SELECT * FROM memory_nodes WHERE start=? AND count=?",
      part.start,
      part.count
    )
  }
  nodeCount() {
    return this.row(StoredCount, "SELECT count(*) AS n FROM memory_nodes")!.n
  }
  viewNodes() {
    return this.rows(
      StoredNode,
      "SELECT n.* FROM memory_view v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count ORDER BY v.start"
    )
  }
  entry(id: number) {
    return this.row(LogEntry, "SELECT * FROM memory_log WHERE id = ?", id)
  }
  fitViews() {
    const changed = this.fit("memory_view", 1, this.budget)
    if (changed) {
      this.db.run("DELETE FROM memory_compaction_view")
      this.db.run(
        "INSERT INTO memory_compaction_view SELECT * FROM memory_view"
      )
      this.db.run("UPDATE memory_view_state SET compacting=1 WHERE id=2")
    }
    this.fit("memory_compaction_view", 2, this.budget / 4)
  }
  fit(
    table: "memory_view" | "memory_compaction_view",
    stateId: number,
    budget: number
  ) {
    const parts = this.rows(
        StoredPart,
        `SELECT * FROM ${table} ORDER BY start`
      ),
      total = this.total(),
      nodes = new Map<string, MemoryNode>()
    for (const node of this.rows(
      StoredNode,
      `SELECT n.* FROM ${table} v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count`
    ))
      nodes.set(nodeKey(node), node)
    const compacting =
      this.row(
        StoredViewState,
        "SELECT compacting FROM memory_view_state WHERE id=?",
        stateId
      )?.compacting === 1
    if (!Policy.shouldFitMemory(parts, nodes, compacting, budget)) return false
    for (const part of Policy.memoryAncestors(parts, total)) {
      if (nodes.has(nodeKey(part))) continue
      const node = this.node(part)
      if (node) nodes.set(nodeKey(part), node)
    }
    const plan = Policy.fitMemory(parts, total, nodes, budget)
    this.db.run(
      "UPDATE memory_view_state SET compacting=? WHERE id=?",
      plan.compacting ? 1 : 0,
      stateId
    )
    if (!plan.changed) return false
    this.db.run(`DELETE FROM ${table}`)
    for (const part of plan.view)
      this.db.run(`INSERT INTO ${table} VALUES (?,?)`, part.start, part.count)
    return true
  }
  saveNode(part: Part, text: string) {
    this.db.transaction(() => {
      const plan = Policy.summarySavePlan(part, text, this.total())
      Policy.requireSummaryChildren(
        plan.children.map((child) => this.node(child))
      )
      this.db.run(
        "INSERT OR IGNORE INTO memory_nodes VALUES (?,?,?,?)",
        part.start,
        part.count,
        text,
        plan.bytes
      )
      this.db.run(
        "DELETE FROM memory_ready WHERE start=? AND count=?",
        part.start,
        part.count
      )
      if (
        Policy.parentReady(
          !!this.node(plan.parent),
          Policy.summaryChildren(plan.parent).map((child) => this.node(child))
        )
      )
        this.db.run(
          "INSERT OR IGNORE INTO memory_ready VALUES (?,?)",
          plan.parent.start,
          plan.parent.count
        )
      this.fitViews()
      this.db.run(
        "DELETE FROM memory_failures WHERE start=? AND count=?",
        part.start,
        part.count
      )
    })
  }
  private failure(part: Part) {
    return this.row(
      StoredFailure,
      "SELECT start,count,attempts,retry_at FROM memory_failures WHERE start=? AND count=?",
      part.start,
      part.count
    )
  }
  failNode(part: Part, retryAt: number) {
    return this.db.transaction(() => {
      const plan = Policy.summaryFailure(this.failure(part)?.attempts, retryAt)
      this.db.run(
        "INSERT INTO memory_failures(start,count,retry_at,attempts) VALUES (?,?,?,?) ON CONFLICT(start,count) DO UPDATE SET retry_at=excluded.retry_at,attempts=excluded.attempts",
        part.start,
        part.count,
        plan.retryAt,
        plan.attempts
      )
      return plan.first
    })
  }
  retryAt() {
    return this.row(
      StoredFailure,
      "SELECT start,count,attempts,retry_at FROM memory_failures WHERE attempts<? ORDER BY retry_at LIMIT 1",
      Policy.SUMMARY_FAILURES
    )?.retry_at
  }
  issues() {
    return this.rows(
      StoredIssue,
      "SELECT start,count,attempts,CASE WHEN attempts<? THEN retry_at ELSE NULL END AS retryAt FROM memory_failures ORDER BY start,count LIMIT 100",
      Policy.SUMMARY_FAILURES
    )
  }
  paused(part: Part) {
    return (this.failure(part)?.attempts ?? 0) >= Policy.SUMMARY_FAILURES
  }
  retrySummary(part: Part) {
    if (!this.paused(part)) return false
    this.db.run(
      "DELETE FROM memory_failures WHERE start=? AND count=?",
      part.start,
      part.count
    )
    return true
  }
  next(busy: Set<string>, now: number): SummaryJob | undefined {
    const view = this.rows(
      StoredNode,
      "SELECT n.* FROM memory_compaction_view v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count ORDER BY v.start"
    )
    const first =
      this.row(
        StoredPart,
        "SELECT v.start,v.count FROM memory_view v LEFT JOIN memory_nodes n ON n.start=v.start AND n.count=v.count WHERE n.start IS NULL ORDER BY v.start LIMIT 1"
      )?.start ?? this.total()
    const leaves = this.rows(
      LogEntry,
      "SELECT l.* FROM memory_ready q JOIN memory_log l ON l.id=q.start LEFT JOIN memory_failures f ON f.start=q.start AND f.count=q.count WHERE q.count=1 AND q.start<=? AND (f.start IS NULL OR (f.attempts<? AND f.retry_at<=?)) ORDER BY q.start LIMIT 1",
      first,
      Policy.SUMMARY_FAILURES,
      now
    )
    const parents = this.rows(
      StoredMerge,
      "SELECT q.start,q.count,a.text AS left_text,b.text AS right_text FROM memory_ready q JOIN memory_nodes a ON a.start=q.start AND a.count=q.count/2 JOIN memory_nodes b ON b.start=q.start+q.count/2 AND b.count=q.count/2 LEFT JOIN memory_failures f ON f.start=q.start AND f.count=q.count WHERE q.count>1 AND q.start+q.count<=? AND (f.start IS NULL OR (f.attempts<? AND f.retry_at<=?)) ORDER BY q.count,q.start LIMIT ?",
      first,
      Policy.SUMMARY_FAILURES,
      now,
      busy.size + 1
    )
    return Policy.summaryJob(leaves, parents, busy, view)
  }
  blocked() {
    return !!this.row(
      StoredFailure,
      "SELECT f.start,f.count,f.attempts,f.retry_at FROM memory_view v JOIN memory_failures f ON f.start=v.start AND f.count=v.count LEFT JOIN memory_nodes n ON n.start=v.start AND n.count=v.count WHERE f.attempts>=? AND n.start IS NULL LIMIT 1",
      Policy.SUMMARY_FAILURES
    )
  }
  settled() {
    return this.parts().length === this.viewNodes().length
  }
  render() {
    return Policy.renderMemory(this.viewNodes(), this.parts().length)
  }
  zoom(start: number, count: number): string {
    const part = { start, count }
    Policy.requireMemoryRange(part, this.total())
    return Policy.zoomMemory(
      part,
      count === 1 ? this.entry(start) : undefined,
      Policy.summaryChildren(part).map((child) => this.node(child))
    )
  }
  search(query: string) {
    return this.rows(
      LogEntry,
      "SELECT * FROM memory_log WHERE instr(lower(text),lower(?)) > 0 ORDER BY id DESC LIMIT 30",
      query
    )
  }
  notes() {
    return this.rows(StoredNote, "SELECT * FROM memory_notes ORDER BY path")
  }
  writeNote(path: string, body: string, sourceId: number, date: string) {
    Policy.requireMemoryNote(path, body, true)
    this.db.transaction(() => {
      Policy.requireMemoryNote(path, body, !!this.entry(sourceId))
      this.db.run(
        "INSERT INTO memory_note_history(path,body,source_id,date) VALUES (?,?,?,?)",
        path,
        body,
        sourceId,
        date
      )
      this.db.run(
        "INSERT INTO memory_notes VALUES (?,?,?,?) ON CONFLICT(path) DO UPDATE SET body=excluded.body,source_id=excluded.source_id,updated_at=excluded.updated_at",
        path,
        body,
        sourceId,
        date
      )
    })
  }
  watermark(): Watermark {
    return {
      messages: this.total(),
      nodes: this.row(
        StoredCount,
        "SELECT coalesce(max(rowid),0) AS n FROM memory_nodes"
      )!.n,
      notes: this.row(
        StoredCount,
        "SELECT coalesce(max(id),0) AS n FROM memory_note_history"
      )!.n,
    }
  }
  archivePage(after: Watermark, until: Watermark, limit = 32): ArchiveRecord[] {
    const messages = this.db.all<typeof MessageRecord.Type>(
      "SELECT 'message' AS type,* FROM memory_log WHERE id>=? AND id<? ORDER BY id LIMIT ?",
      after.messages,
      until.messages,
      limit
    )
    const nodes = this.db.all<typeof NodeRecord.Type>(
      "SELECT 'node' AS type,rowid AS seq,* FROM memory_nodes WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",
      after.nodes,
      until.nodes,
      limit - messages.length
    )
    const notes = this.db.all<typeof NoteRecord.Type>(
      "SELECT 'note' AS type,* FROM memory_note_history WHERE id>? AND id<=? ORDER BY id LIMIT ?",
      after.notes,
      until.notes,
      limit - messages.length - nodes.length
    )
    return [...messages, ...nodes, ...notes].map((record) =>
      Schema.decodeUnknownSync(StoredArchiveRecord)(record)
    )
  }
  restore(records: readonly ArchiveRecord[], parts: readonly Part[]) {
    this.db.transaction(() => {
      if (this.total() || this.nodeCount() || this.notes().length)
        throw new InvalidMemory({
          message: "Restore requires an empty memory store",
        })
      const plan = Policy.memoryRestorePlan(records, parts)
      for (const record of plan.messages)
        this.append(record.source, record.kind, record.text, record.date)
      for (const record of plan.nodes)
        this.db.run(
          "INSERT INTO memory_nodes(rowid,start,count,text,bytes) VALUES (?,?,?,?,?)",
          record.seq,
          record.start,
          record.count,
          record.text,
          record.bytes
        )
      for (const record of plan.notes) {
        this.writeNote(record.path, record.body, record.source_id, record.date)
        this.db.run(
          "UPDATE memory_note_history SET id=? WHERE id=(SELECT max(id) FROM memory_note_history)",
          record.id
        )
        this.db.run(
          "UPDATE memory_note_history SET date=? WHERE id=(SELECT max(id) FROM memory_note_history)",
          record.date
        )
        this.db.run(
          "UPDATE memory_notes SET updated_at=? WHERE path=?",
          record.date,
          record.path
        )
      }
      this.db.run("DELETE FROM memory_ready")
      this.db.run(
        "INSERT OR IGNORE INTO memory_ready SELECT l.id,1 FROM memory_log l LEFT JOIN memory_nodes n ON n.start=l.id AND n.count=1 WHERE n.start IS NULL"
      )
      this.db.run(
        "INSERT OR IGNORE INTO memory_ready SELECT a.start,a.count*2 FROM memory_nodes a JOIN memory_nodes b ON b.start=a.start+a.count AND b.count=a.count LEFT JOIN memory_nodes p ON p.start=a.start AND p.count=a.count*2 WHERE a.start%(a.count*2)=0 AND p.start IS NULL"
      )
      this.db.run("DELETE FROM memory_compaction_view")
      this.db.run("UPDATE memory_view_state SET compacting=0 WHERE id=1")
      this.db.run("UPDATE memory_view_state SET compacting=1 WHERE id=2")
      for (const part of parts)
        this.db.run(
          "INSERT INTO memory_compaction_view VALUES (?,?)",
          part.start,
          part.count
        )
      this.db.run("DELETE FROM memory_view")
      for (const part of parts)
        this.db.run(
          "INSERT INTO memory_view VALUES (?,?)",
          part.start,
          part.count
        )
    })
  }

  importEntries(
    id: string,
    records: readonly { kind: LogKind; text: string; date: string }[]
  ) {
    return this.db.transaction(() => {
      const before = this.total()
      records.forEach((r, i) =>
        this.append(`import:${id}:${i}`, r.kind, r.text, r.date)
      )
      return this.total() - before
    })
  }
}

const openSqliteMemory = Effect.fn("Memory.sqlite.open")(function* (
  db: Sqlite,
  budget = VIEW_BYTES
) {
  const storage = yield* Effect.try({
    try: () => new SqliteMemory(db, budget),
    catch: (cause) => {
      const memoryStorageError =
        Schema.decodeUnknownOption(MemoryStorageError)(cause)
      if (memoryStorageError._tag === "Some")
        return new MemoryStorageError({ operation: "open" })
      throw cause
    },
  })
  return storage
})
export const makeSqliteMemory = (db: Sqlite, budget = VIEW_BYTES) =>
  openSqliteMemory(db, budget).pipe(Effect.map(makeMemoryRepository))
export const sqliteMemoryLayer = (db: Sqlite, budget = VIEW_BYTES) =>
  Layer.unwrap(
    openSqliteMemory(db, budget).pipe(
      Effect.map((ledger) =>
        Layer.mergeAll(
          memoryApplication(ledger),
          Layer.succeed(MemoryTransaction, ledger)
        )
      )
    )
  )
