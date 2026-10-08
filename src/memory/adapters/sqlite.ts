import { Clock, Effect, Layer } from "effect"
import type { Sqlite } from "../../storage/sqlite"
import { MemoryRepository } from "../repository"
import {
  byteLength,
  fitView,
  validRange,
  nodeKey,
  VIEW_BYTES,
  InvalidMemory,
  MemoryNotReady,
  MemoryStorageError,
  type LogEntry,
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
} from "../records"

class SqliteMemory {
  constructor(
    readonly db: Sqlite,
    readonly budget = VIEW_BYTES
  ) {
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
    // The only historical scan is this atomic, one-time upgrade. Reopening an
    // actor preserves its exact views and ready queue instead of refitting them.
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

  append(source: string, kind: LogKind, text: string, date: string): LogEntry {
    return this.db.transaction(() => {
      const prior = this.db.all<LogEntry>(
        "SELECT * FROM memory_log WHERE source = ?",
        source
      )[0]
      if (prior) return prior
      const id = this.total()
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
      return { id, source, kind, text, date }
    })
  }
  total() {
    return this.db.all<{ n: number }>(
      "SELECT coalesce(max(id)+1,0) AS n FROM memory_log"
    )[0]!.n
  }
  parts() {
    return this.db.all<Part>("SELECT * FROM memory_view ORDER BY start")
  }
  node(part: Part) {
    return this.db.all<MemoryNode>(
      "SELECT * FROM memory_nodes WHERE start=? AND count=?",
      part.start,
      part.count
    )[0]
  }
  nodeCount() {
    return this.db.all<{ n: number }>(
      "SELECT count(*) AS n FROM memory_nodes"
    )[0]!.n
  }
  viewNodes() {
    return this.db.all<MemoryNode>(
      "SELECT n.* FROM memory_view v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count ORDER BY v.start"
    )
  }
  entry(id: number) {
    return this.db.all<LogEntry>("SELECT * FROM memory_log WHERE id = ?", id)[0]
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
    const parts = this.db.all<Part>(`SELECT * FROM ${table} ORDER BY start`),
      total = this.total(),
      nodes = new Map<string, MemoryNode>()
    for (const node of this.db.all<MemoryNode>(
      `SELECT n.* FROM ${table} v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count`
    ))
      nodes.set(nodeKey(node), node)
    const bytes = parts.reduce(
      (sum, part) => sum + (nodes.get(nodeKey(part))?.bytes ?? 0),
      0
    )
    const compacting = !!this.db.all<{ compacting: number }>(
      "SELECT compacting FROM memory_view_state WHERE id=?",
      stateId
    )[0]?.compacting
    if (!compacting && bytes <= budget) return false
    // Load only the bounded view and its ancestors, never the whole historical tree.
    for (const part of parts)
      for (let count = part.count; count <= total; count *= 2) {
        const start = Math.floor(part.start / count) * count,
          key = nodeKey({ start, count })
        if (nodes.has(key)) continue
        const node = this.node({ start, count })
        if (node) nodes.set(key, node)
      }
    const target = budget / 2
    const view = fitView(parts, total, nodes, target)
    const remaining = view.reduce(
      (sum, part) => sum + (nodes.get(nodeKey(part))?.bytes ?? 0),
      0
    )
    this.db.run(
      "UPDATE memory_view_state SET compacting=? WHERE id=?",
      remaining > target ? 1 : 0,
      stateId
    )
    if (view.length === parts.length) return false
    this.db.run(`DELETE FROM ${table}`)
    for (const part of view)
      this.db.run(`INSERT INTO ${table} VALUES (?,?)`, part.start, part.count)
    return true
  }
  saveNode(part: Part, text: string) {
    if (!text.trim())
      throw new InvalidMemory({ message: "Empty memory summary" })
    this.db.transaction(() => {
      if (
        !validRange(part, this.total()) ||
        (part.count > 1 &&
          (!this.node({ start: part.start, count: part.count / 2 }) ||
            !this.node({
              start: part.start + part.count / 2,
              count: part.count / 2,
            })))
      )
        throw new InvalidMemory({
          message: "Invalid summary range or missing children",
        })
      this.db.run(
        "INSERT OR IGNORE INTO memory_nodes VALUES (?,?,?,?)",
        part.start,
        part.count,
        text,
        byteLength(text)
      )
      this.db.run(
        "DELETE FROM memory_ready WHERE start=? AND count=?",
        part.start,
        part.count
      )
      const parent = {
        start: Math.floor(part.start / (part.count * 2)) * part.count * 2,
        count: part.count * 2,
      }
      if (
        !this.node(parent) &&
        this.node({ start: parent.start, count: part.count }) &&
        this.node({ start: parent.start + part.count, count: part.count })
      )
        this.db.run(
          "INSERT OR IGNORE INTO memory_ready VALUES (?,?)",
          parent.start,
          parent.count
        )
      this.fitViews()
      this.db.run(
        "DELETE FROM memory_failures WHERE start=? AND count=?",
        part.start,
        part.count
      )
    })
  }
  failNode(part: Part, retryAt: number) {
    const first = !this.db.all(
      "SELECT 1 FROM memory_failures WHERE start=? AND count=?",
      part.start,
      part.count
    ).length
    this.db.run(
      "INSERT INTO memory_failures VALUES (?,?,?) ON CONFLICT(start,count) DO UPDATE SET retry_at=excluded.retry_at",
      part.start,
      part.count,
      retryAt
    )
    return first
  }
  retryAt() {
    return (
      this.db.all<{ time: number | null }>(
        "SELECT min(retry_at) AS time FROM memory_failures"
      )[0]?.time ?? undefined
    )
  }
  /** Source-order barrier: the summarizer never sees raw or partial older messages. */
  next(busy: Set<string>, now: number): SummaryJob | undefined {
    const view = this.db.all<MemoryNode>(
        "SELECT n.* FROM memory_compaction_view v JOIN memory_nodes n ON n.start=v.start AND n.count=v.count ORDER BY v.start"
      ),
      first =
        this.db.all<{ start: number }>(
          "SELECT v.start FROM memory_view v LEFT JOIN memory_nodes n ON n.start=v.start AND n.count=v.count WHERE n.start IS NULL ORDER BY v.start LIMIT 1"
        )[0]?.start ?? this.total()
    const leaf = this.db
      .all<LogEntry>(
        "SELECT l.* FROM memory_ready q JOIN memory_log l ON l.id=q.start LEFT JOIN memory_failures f ON f.start=q.start AND f.count=q.count WHERE q.count=1 AND q.start<=? AND (f.retry_at IS NULL OR f.retry_at<=?) ORDER BY q.start LIMIT 1",
        first,
        now
      )
      .find((entry) => !busy.has(nodeKey({ start: entry.id, count: 1 })))
    const parent = leaf
      ? undefined
      : this.db
          .all<Part & { left_text: string; right_text: string }>(
            `SELECT q.start,q.count,a.text AS left_text,b.text AS right_text FROM memory_ready q JOIN memory_nodes a ON a.start=q.start AND a.count=q.count/2 JOIN memory_nodes b ON b.start=q.start+q.count/2 AND b.count=q.count/2 LEFT JOIN memory_failures f ON f.start=q.start AND f.count=q.count WHERE q.count>1 AND q.start+q.count<=? AND (f.retry_at IS NULL OR f.retry_at<=?) ORDER BY q.count,q.start LIMIT ?`,
            first,
            now,
            busy.size + 1
          )
          .find((part) => !busy.has(nodeKey(part)))
    if (!leaf && !parent) return
    const start = leaf ? leaf.id : parent!.start,
      count = leaf ? 1 : parent!.count
    const end = leaf ? start : start + count
    return {
      start,
      count,
      source: leaf
        ? `${leaf.kind}: ${leaf.text}`
        : `${parent!.left_text}\n${parent!.right_text}`,
      context: view
        .filter((p) => p.start + p.count <= end)
        .map((p) => `${nodeKey(p)}|${p.text.replaceAll("\n", " ")}`)
        .join("\n"),
    }
  }
  settled() {
    return this.parts().length === this.viewNodes().length
  }
  render() {
    const view = this.viewNodes()
    if (view.length !== this.parts().length) throw new MemoryNotReady()
    return `<chat>\n${view.map((p) => `${nodeKey(p)}|${p.text.replaceAll("\n", " ")}`).join("\n")}\n</chat>`
  }
  zoom(start: number, count: number): string {
    if (!validRange({ start, count }, this.total()))
      throw new InvalidMemory({ message: "No such memory range" })
    if (count === 1) {
      const entry = this.entry(start)!
      return `${start}+0|${entry.kind}: ${entry.text}`
    }
    return [start, start + count / 2]
      .map((id) => {
        const node = this.node({ start: id, count: count / 2 })
        if (!node) throw new MemoryNotReady()
        return `${nodeKey(node)}|${node.text}`
      })
      .join("\n")
  }
  search(query: string) {
    return this.db.all<LogEntry>(
      "SELECT * FROM memory_log WHERE instr(lower(text),lower(?)) > 0 ORDER BY id DESC LIMIT 30",
      query
    )
  }
  notes() {
    return this.db.all<{
      path: string
      body: string
      source_id: number
      updated_at: string
    }>("SELECT * FROM memory_notes ORDER BY path")
  }
  writeNote(path: string, body: string, sourceId: number, date: string) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_/-]*\.md$/.test(path) ||
      path.includes("..") ||
      body.length > 16_000 ||
      !this.entry(sourceId)
    )
      throw new InvalidMemory({ message: "Invalid memory note" })
    this.db.transaction(() => {
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
      nodes: this.db.all<{ n: number }>(
        "SELECT coalesce(max(rowid),0) AS n FROM memory_nodes"
      )[0]!.n,
      notes: this.db.all<{ n: number }>(
        "SELECT coalesce(max(id),0) AS n FROM memory_note_history"
      )[0]!.n,
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
    return [...messages, ...nodes, ...notes]
  }
  restore(records: readonly ArchiveRecord[], parts: readonly Part[]) {
    if (this.total() || this.nodeCount() || this.notes().length)
      throw new InvalidMemory({
        message: "Restore requires an empty memory store",
      })
    this.db.transaction(() => {
      for (const r of records
        .filter((record) => record.type === "message")
        .sort((a, b) => a.id - b.id)) {
        if (r.id !== this.total())
          throw new InvalidMemory({
            message: "Archive message IDs are not contiguous",
          })
        if (!Number.isFinite(Date.parse(r.date)))
          throw new InvalidMemory({ message: "Invalid message date" })
        const saved = this.append(r.source, r.kind, r.text, r.date)
        if (saved.id !== r.id)
          throw new InvalidMemory({ message: "Duplicate archive source" })
      }
      let nodeSeq = 0
      for (const r of records
        .filter((record) => record.type === "node")
        .sort((a, b) => a.seq - b.seq)) {
        if (
          r.count < 1 ||
          Math.log2(r.count) % 1 ||
          r.start % r.count ||
          r.start + r.count > this.total() ||
          r.bytes !== byteLength(r.text)
        )
          throw new InvalidMemory({ message: "Invalid summary range or size" })
        if (
          r.count > 1 &&
          (!this.node({ start: r.start, count: r.count / 2 }) ||
            !this.node({ start: r.start + r.count / 2, count: r.count / 2 }))
        )
          throw new InvalidMemory({ message: "Missing summary children" })
        if (r.seq !== ++nodeSeq || this.node(r))
          throw new InvalidMemory({ message: "Duplicate summary" })
        this.db.run(
          "INSERT INTO memory_nodes(rowid,start,count,text,bytes) VALUES (?,?,?,?,?)",
          r.seq,
          r.start,
          r.count,
          r.text,
          r.bytes
        )
      }
      let noteSeq = 0
      for (const r of records
        .filter((record) => record.type === "note")
        .sort((a, b) => a.id - b.id)) {
        if (r.id !== ++noteSeq || !Number.isFinite(Date.parse(r.date)))
          throw new InvalidMemory({ message: "Invalid note revision" })
        this.writeNote(r.path, r.body, r.source_id, r.date)
        this.db.run(
          "UPDATE memory_note_history SET id=? WHERE id=(SELECT max(id) FROM memory_note_history)",
          r.id
        )
        this.db.run(
          "UPDATE memory_note_history SET date=? WHERE id=(SELECT max(id) FROM memory_note_history)",
          r.date
        )
        this.db.run(
          "UPDATE memory_notes SET updated_at=? WHERE path=?",
          r.date,
          r.path
        )
      }
      let end = 0
      for (const part of parts) {
        if (
          part.start !== end ||
          part.count < 1 ||
          !Number.isSafeInteger(part.start) ||
          !Number.isSafeInteger(part.count) ||
          Math.log2(part.count) % 1 ||
          part.start % part.count ||
          (part.count > 1 && !this.node(part))
        )
          throw new InvalidMemory({ message: "Invalid archive view" })
        end += part.count
      }
      if (end !== this.total())
        throw new InvalidMemory({
          message: "Archive view does not cover its messages",
        })
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

/** The adapter owns atomic SQL operations. No synchronous driver escapes this port. */
export const makeSqliteMemory = Effect.fn("Memory.sqlite.open")(function* (
  db: Sqlite,
  budget = VIEW_BYTES
) {
  const storage = yield* Effect.try({
    try: () => new SqliteMemory(db, budget),
    catch: () => new MemoryStorageError({ operation: "open" }),
  })
  const read = <T>(operation: string, body: () => T) =>
    Effect.try({
      try: body,
      catch: (error) =>
        error instanceof InvalidMemory || error instanceof MemoryNotReady
          ? error
          : new MemoryStorageError({ operation }),
    })
  const date = Clock.currentTimeMillis.pipe(
    Effect.map((now) => new Date(now).toISOString())
  )
  return MemoryRepository.of({
    append: Effect.fn("Memory.append")(function* (source, kind, text, at) {
      const timestamp = at ?? (yield* date)
      return yield* read("append", () =>
        storage.append(source, kind, text, timestamp)
      )
    }),
    total: () => read("total", () => storage.total()),
    parts: () => read("parts", () => storage.parts()),
    node: (part) => read("node", () => storage.node(part)),
    nodeCount: () => read("nodeCount", () => storage.nodeCount()),
    entry: (id) => read("entry", () => storage.entry(id)),
    saveNode: (part, text) =>
      read("saveNode", () => storage.saveNode(part, text)),
    failNode: (part, retryAt) =>
      read("failNode", () => storage.failNode(part, retryAt)),
    retryAt: () => read("retryAt", () => storage.retryAt()),
    next: (busy = new Set(), now) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((current) =>
          read("next", () => storage.next(busy, now ?? current))
        )
      ),
    settled: () => read("settled", () => storage.settled()),
    render: () => read("render", () => storage.render()),
    zoom: (start, count) => read("zoom", () => storage.zoom(start, count)),
    search: (query) => read("search", () => storage.search(query)),
    notes: () => read("notes", () => storage.notes()),
    writeNote: Effect.fn("Memory.writeNote")(function* (path, body, sourceId) {
      const timestamp = yield* date
      yield* read("writeNote", () =>
        storage.writeNote(path, body, sourceId, timestamp)
      )
    }),
    watermark: () => read("watermark", () => storage.watermark()),
    snapshot: () =>
      read("snapshot", () => {
        const until = storage.watermark(),
          parts = storage.parts()
        const view = parts.map((part) => {
          const node = storage.node(part)
          return { ...part, text: node?.text, built: !!node }
        })
        return { until, parts, view }
      }),
    archivePage: (after, until, limit) =>
      read("archivePage", () => storage.archivePage(after, until, limit)),
    restore: (records, parts) =>
      read("restore", () => storage.restore(records, parts)),
    importEntries: (id, records) =>
      read("import", () => storage.importEntries(id, records)),
  })
})
export const sqliteMemoryLayer = (db: Sqlite, budget = VIEW_BYTES) =>
  Layer.effect(MemoryRepository, makeSqliteMemory(db, budget))
