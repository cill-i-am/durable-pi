import * as Schema from "effect/Schema"
import { byteLength, type MemoryStore, type Part } from "./memory"

const Integer = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
export const MessageRecord = Schema.Struct({
  type: Schema.Literal("message"),
  id: Integer,
  source: Schema.String,
  kind: Schema.Literals(["user", "talk", "tool", "echo", "note"]),
  text: Schema.String,
  date: Schema.String,
})
export const NodeRecord = Schema.Struct({
  type: Schema.Literal("node"),
  seq: Integer,
  start: Integer,
  count: Integer,
  text: Schema.String,
  bytes: Integer,
})
export const NoteRecord = Schema.Struct({
  type: Schema.Literal("note"),
  id: Integer,
  path: Schema.String,
  body: Schema.String,
  source_id: Integer,
  date: Schema.String,
})
export const ArchiveRecord = Schema.Union([
  MessageRecord,
  NodeRecord,
  NoteRecord,
])
export type ArchiveRecord = typeof ArchiveRecord.Type
export type Watermark = { messages: number; nodes: number; notes: number }
export const emptyWatermark: Watermark = { messages: 0, nodes: 0, notes: 0 }
export function watermark(memory: MemoryStore): Watermark {
  return {
    messages: memory.total(),
    nodes: memory.db.all<{ n: number }>(
      "SELECT coalesce(max(rowid),0) AS n FROM memory_nodes"
    )[0]!.n,
    notes: memory.db.all<{ n: number }>(
      "SELECT coalesce(max(id),0) AS n FROM memory_note_history"
    )[0]!.n,
  }
}
export function archivePage(
  memory: MemoryStore,
  after: Watermark,
  until: Watermark,
  limit = 32
): ArchiveRecord[] {
  const messages = memory.db.all<typeof MessageRecord.Type>(
    "SELECT 'message' AS type,* FROM memory_log WHERE id>=? AND id<? ORDER BY id LIMIT ?",
    after.messages,
    until.messages,
    limit
  )
  const nodes = memory.db.all<typeof NodeRecord.Type>(
    "SELECT 'node' AS type,rowid AS seq,* FROM memory_nodes WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT ?",
    after.nodes,
    until.nodes,
    limit - messages.length
  )
  const notes = memory.db.all<typeof NoteRecord.Type>(
    "SELECT 'note' AS type,* FROM memory_note_history WHERE id>? AND id<=? ORDER BY id LIMIT ?",
    after.notes,
    until.notes,
    limit - messages.length - nodes.length
  )
  return [...messages, ...nodes, ...notes]
}
export function advance(
  after: Watermark,
  records: readonly ArchiveRecord[]
): Watermark {
  const next = { ...after }
  for (const record of records) {
    if (record.type === "message")
      next.messages = Math.max(next.messages, record.id + 1)
    if (record.type === "node") next.nodes = Math.max(next.nodes, record.seq)
    if (record.type === "note") next.notes = Math.max(next.notes, record.id)
  }
  return next
}
export function* archive(memory: MemoryStore, until = watermark(memory)) {
  let after = emptyWatermark
  for (;;) {
    const records = archivePage(memory, after, until)
    if (!records.length) return
    yield* records
    after = advance(after, records)
  }
}

/** Restores a downloaded archive into an empty local store, never overwriting live history. */
export function restoreArchive(
  memory: MemoryStore,
  input: unknown[],
  parts: readonly Part[]
) {
  const records = Schema.decodeUnknownSync(Schema.Array(ArchiveRecord))(input)
  if (memory.total() || memory.nodeCount() || memory.notes().length)
    throw new Error("Restore requires an empty memory store")
  memory.db.transaction(() => {
    for (const r of records
      .filter((record) => record.type === "message")
      .sort((a, b) => a.id - b.id)) {
      if (r.id !== memory.total())
        throw new Error("Archive message IDs are not contiguous")
      if (!Number.isFinite(Date.parse(r.date)))
        throw new Error("Invalid message date")
      const saved = memory.append(r.source, r.kind, r.text, r.date)
      if (saved.id !== r.id) throw new Error("Duplicate archive source")
    }
    let nodeSeq = 0
    for (const r of records
      .filter((record) => record.type === "node")
      .sort((a, b) => a.seq - b.seq)) {
      if (
        r.count < 1 ||
        Math.log2(r.count) % 1 ||
        r.start % r.count ||
        r.start + r.count > memory.total() ||
        r.bytes !== byteLength(r.text)
      )
        throw new Error("Invalid summary range or size")
      if (
        r.count > 1 &&
        (!memory.node({ start: r.start, count: r.count / 2 }) ||
          !memory.node({ start: r.start + r.count / 2, count: r.count / 2 }))
      )
        throw new Error("Missing summary children")
      if (r.seq !== ++nodeSeq || memory.node(r))
        throw new Error("Duplicate summary")
      memory.db.run(
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
        throw new Error("Invalid note revision")
      memory.writeNote(r.path, r.body, r.source_id)
      memory.db.run(
        "UPDATE memory_note_history SET id=? WHERE id=(SELECT max(id) FROM memory_note_history)",
        r.id
      )
      memory.db.run(
        "UPDATE memory_note_history SET date=? WHERE id=(SELECT max(id) FROM memory_note_history)",
        r.date
      )
      memory.db.run(
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
        (part.count > 1 && !memory.node(part))
      )
        throw new Error("Invalid archive view")
      end += part.count
    }
    if (end !== memory.total())
      throw new Error("Archive view does not cover its messages")
    memory.db.run("DELETE FROM memory_view")
    for (const part of parts)
      memory.db.run(
        "INSERT INTO memory_view VALUES (?,?)",
        part.start,
        part.count
      )
  })
}

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )
export function exportResponse(memory: MemoryStore, html = false) {
  const until = watermark(memory),
    parts = memory.parts(),
    view = parts.map((part) => ({
      ...part,
      text: memory.node(part)?.text,
      built: !!memory.node(part),
    })),
    created = new Date().toISOString()
  const rows = archive(memory, until)
  function* output() {
    if (html) {
      yield '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Pi memory archive</title><style>body{font:15px system-ui;max-width:1000px;margin:40px auto;padding:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #ddd;padding:12px 0}a{color:#285340}</style><h1>Pi memory archive</h1><p>Private archive. Keep this file somewhere safe.</p><h2>Current view</h2>'
      for (const part of view)
        yield `<p><a href="#${part.built ? `node-${part.start}-${part.count}` : `message-${part.start}`}">${part.start}+${part.count}</a> ${escapeHtml(part.text ?? "Not summarized yet")}</p>`
      yield "<h2>Messages, summaries and note revisions</h2>"
    } else
      yield JSON.stringify({
        type: "header",
        format: "durable-pi-memory",
        version: 1,
        created,
        parts,
        until,
      }) + "\n"
    for (const row of rows) {
      if (!html) {
        yield JSON.stringify(row) + "\n"
        continue
      }
      if (row.type === "message")
        yield `<article id="message-${row.id}"><h3>${row.id}+0 · ${row.kind}</h3><small>${escapeHtml(row.date)} · ${byteLength(row.text)} bytes</small><pre>${escapeHtml(row.text)}</pre></article>`
      if (row.type === "node") {
        const children =
          row.count === 1
            ? `<a href="#message-${row.start}">Original message</a>`
            : [row.start, row.start + row.count / 2]
                .map(
                  (start) =>
                    `<a href="#node-${start}-${row.count / 2}">${start}+${row.count / 2}</a>`
                )
                .join(" · ")
        yield `<article id="node-${row.start}-${row.count}"><h3>${row.start}+${row.count} · level ${Math.log2(row.count)}</h3><small>${row.bytes} bytes · ${children}</small><pre>${escapeHtml(row.text)}</pre></article>`
      }
      if (row.type === "note")
        yield `<article><h3>${escapeHtml(row.path)} · revision ${row.id}</h3><a href="#message-${row.source_id}">Source message ${row.source_id}</a><pre>${escapeHtml(row.body)}</pre></article>`
    }
    yield html ? "</html>" : JSON.stringify({ type: "end", until }) + "\n"
  }
  const iterator = output(),
    encoder = new TextEncoder()
  return new Response(
    new ReadableStream({
      pull(controller) {
        const next = iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      },
      cancel() {
        iterator.return()
      },
    }),
    {
      headers: {
        "content-type": html
          ? "text/html; charset=utf-8"
          : "application/x-ndjson",
        "content-disposition": `attachment; filename="pi-memory-${created.slice(0, 10)}.${html ? "html" : "jsonl"}"`,
        "cache-control": "private, no-store",
        "content-security-policy":
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
      },
    }
  )
}

const WatermarkSchema = Schema.Struct({
  messages: Integer,
  nodes: Integer,
  notes: Integer,
})
const Header = Schema.Struct({
  type: Schema.Literal("header"),
  format: Schema.Literal("durable-pi-memory"),
  version: Schema.Literal(1),
  parts: Schema.Array(Schema.Struct({ start: Integer, count: Integer })),
  until: WatermarkSchema,
})
const Footer = Schema.Struct({
  type: Schema.Literal("end"),
  until: WatermarkSchema,
})
/** For the offline restore CLI. Live history imports use the smaller message-only format. */
export function parseArchive(jsonl: string) {
  const lines = jsonl.trim().split(/\r?\n/),
    header = Schema.decodeUnknownSync(Header)(
      JSON.parse(lines.shift() ?? "null")
    ),
    footer = Schema.decodeUnknownSync(Footer)(JSON.parse(lines.pop() ?? "null"))
  const records = Schema.decodeUnknownSync(Schema.Array(ArchiveRecord))(
    lines.map((line) => JSON.parse(line))
  )
  const actual = advance(emptyWatermark, records)
  for (const key of ["messages", "nodes", "notes"] as const)
    if (
      header.until[key] !== footer.until[key] ||
      actual[key] !== header.until[key]
    )
      throw new Error("Incomplete archive")
  return { records: [...records], parts: [...header.parts] }
}
