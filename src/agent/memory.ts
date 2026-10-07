export type LogKind = "user" | "talk" | "tool" | "echo" | "note"
export type LogEntry = {
  id: number
  source: string
  kind: LogKind
  text: string
  date: string
}
export type Part = { start: number; count: number }
export type MemoryNode = Part & { text: string; bytes: number }
export type Sqlite = {
  all: <T>(query: string, ...bindings: (string | number | null)[]) => T[]
  run: (query: string, ...bindings: (string | number | null)[]) => void
  transaction: <T>(body: () => T) => T
}
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length
export const nodeKey = ({ start, count }: Part) => `${start}+${count}`
export const NODE_BYTES = 512
export const VIEW_BYTES = 128_000

/** Only merge aligned siblings. Persisted parts never split as new text arrives. */
export function fitView(
  parts: Part[],
  total: number,
  nodes: Map<string, MemoryNode>,
  budget: number
): Part[] {
  const view = [...parts]
  const size = (part: Part) => nodes.get(nodeKey(part))?.bytes ?? 40
  let bytes = view.reduce((sum, part) => sum + size(part), 0)
  while (bytes > budget) {
    let best = -1
    let score = -1
    for (let i = 0; i < view.length - 1; i++) {
      const a = view[i]!,
        b = view[i + 1]!
      const parent = nodes.get(nodeKey({ start: a.start, count: a.count * 2 }))
      if (
        a.count !== b.count ||
        a.start % (a.count * 2) !== 0 ||
        b.start !== a.start + a.count ||
        !parent
      )
        continue
      const due = (total - a.start) / (a.count * 4)
      if (due > score) {
        score = due
        best = i
      }
    }
    if (best < 0) break
    const a = view[best]!,
      b = view[best + 1]!
    const parent = { start: a.start, count: a.count * 2 }
    bytes += size(parent) - size(a) - size(b)
    view.splice(best, 2, parent)
  }
  return view
}

export class MemoryStore {
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
      `CREATE TABLE IF NOT EXISTS memory_notes (path TEXT PRIMARY KEY, body TEXT NOT NULL, source_id INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(source_id) REFERENCES memory_log(id))`
    )
    db.run(
      `CREATE TABLE IF NOT EXISTS memory_note_history (id INTEGER PRIMARY KEY, path TEXT NOT NULL, body TEXT NOT NULL, source_id INTEGER NOT NULL, date TEXT NOT NULL)`
    )
  }
  append(
    source: string,
    kind: LogKind,
    text: string,
    date = new Date().toISOString()
  ): LogEntry {
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
      this.fit()
      return { id, source, kind, text, date }
    })
  }
  total() {
    return this.db.all<{ n: number }>(
      "SELECT count(*) AS n FROM memory_log"
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
  fit() {
    const parts = this.parts(),
      total = this.total(),
      nodes = new Map<string, MemoryNode>()
    // Load only the bounded view and its ancestors, never the whole historical tree.
    for (const part of parts)
      for (let count = part.count; count <= total; count *= 2) {
        const start = Math.floor(part.start / count) * count,
          key = nodeKey({ start, count })
        if (nodes.has(key)) continue
        const node = this.node({ start, count })
        if (node) nodes.set(key, node)
      }
    const view = fitView(parts, total, nodes, this.budget)
    this.db.run("DELETE FROM memory_view")
    for (const part of view)
      this.db.run(
        "INSERT INTO memory_view VALUES (?,?)",
        part.start,
        part.count
      )
  }
  saveNode(part: Part, text: string) {
    if (!text.trim()) throw new Error("Empty memory summary")
    this.db.transaction(() => {
      this.db.run(
        "INSERT OR IGNORE INTO memory_nodes VALUES (?,?,?,?)",
        part.start,
        part.count,
        text,
        byteLength(text)
      )
      this.fit()
    })
  }
  /** Source-order barrier: the summarizer never sees raw or partial older messages. */
  next(): (Part & { source: string; context: string }) | undefined {
    const view = this.viewNodes(),
      first =
        this.db.all<{ start: number }>(
          "SELECT v.start FROM memory_view v LEFT JOIN memory_nodes n ON n.start=v.start AND n.count=v.count WHERE n.start IS NULL ORDER BY v.start LIMIT 1"
        )[0]?.start ?? this.total()
    const leaf = this.db.all<LogEntry>(
      "SELECT l.* FROM memory_log l LEFT JOIN memory_nodes n ON n.start=l.id AND n.count=1 WHERE n.start IS NULL AND l.id<=? ORDER BY l.id LIMIT 1",
      first
    )[0]
    const parent = leaf
      ? undefined
      : this.db.all<Part & { left_text: string; right_text: string }>(
          `SELECT a.start,a.count*2 AS count,a.text AS left_text,b.text AS right_text FROM memory_nodes a JOIN memory_nodes b ON b.start=a.start+a.count AND b.count=a.count LEFT JOIN memory_nodes p ON p.start=a.start AND p.count=a.count*2 WHERE a.start%(a.count*2)=0 AND p.start IS NULL AND b.start+b.count<=? ORDER BY a.count,a.start LIMIT 1`,
          first
        )[0]
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
        .map((p) => p.text.replaceAll("\n", " "))
        .join("\n"),
    }
  }
  settled() {
    return this.parts().length === this.viewNodes().length
  }
  render() {
    const view = this.viewNodes()
    if (view.length !== this.parts().length)
      throw new Error("Memory is still being summarized")
    return `<chat>\n${view.map((p) => `${nodeKey(p)}|${p.text.replaceAll("\n", " ")}`).join("\n")}\n</chat>`
  }
  zoom(start: number, count: number): string {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(count) ||
      start < 0 ||
      count < 1 ||
      Math.log2(count) % 1 ||
      start % count ||
      start + count > this.total()
    )
      throw new Error("No such memory range")
    if (count === 1) {
      const entry = this.entry(start)!
      return `${start}+0|${entry.kind}: ${entry.text}`
    }
    return [start, start + count / 2]
      .map((id) => {
        const node = this.node({ start: id, count: count / 2 })
        if (!node) throw new Error("Memory is still being summarized")
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
  writeNote(path: string, body: string, sourceId: number) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_/-]*\.md$/.test(path) ||
      path.includes("..") ||
      body.length > 16_000 ||
      !this.entry(sourceId)
    )
      throw new Error("Invalid memory note")
    this.db.transaction(() => {
      const date = new Date().toISOString()
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
}
