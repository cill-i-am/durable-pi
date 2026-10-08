import { Clock, Effect, Option, Schema, Stream } from "effect"
import { byteLength, InvalidMemory, type Part } from "./domain"
import { MemoryRepository } from "./repository"
import {
  advance,
  ArchiveRecord,
  emptyWatermark,
  PartSchema,
  WatermarkSchema,
} from "./records"
import type { Watermark } from "./records"

/** Paged reads keep exports bounded and backpressured. */
export const archive = (until?: Watermark) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const memory = yield* MemoryRepository
      const highWater = until ?? (yield* memory.watermark())
      return Stream.paginate(
        emptyWatermark,
        Effect.fnUntraced(function* (after) {
          const records = yield* memory.archivePage(after, highWater)
          return [
            records,
            records.length
              ? Option.some(advance(after, records))
              : Option.none<Watermark>(),
          ] as const
        })
      )
    })
  )

export const restoreArchive = Effect.fn("Memory.restore")(function* (
  input: unknown,
  parts: readonly Part[]
) {
  const records = yield* Schema.decodeUnknownEffect(
    Schema.Array(ArchiveRecord)
  )(input).pipe(
    Effect.mapError(
      () => new InvalidMemory({ message: "Invalid archive records" })
    )
  )
  const memory = yield* MemoryRepository
  yield* memory.restore(records, parts)
})

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )

/** The Web Stream captures this Effect context and owns cancellation of its producer. */
export const exportResponse = Effect.fn("Memory.export")(function* (
  html = false
) {
  const memory = yield* MemoryRepository
  const { until, parts, view } = yield* memory.snapshot()
  const created = new Date(yield* Clock.currentTimeMillis).toISOString()
  function* header() {
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
  }
  const renderRow = (row: ArchiveRecord): string => {
    if (!html) {
      return JSON.stringify(row) + "\n"
    }
    if (row.type === "message")
      return `<article id="message-${row.id}"><h3>${row.id}+0 · ${row.kind}</h3><small>${escapeHtml(row.date)} · ${byteLength(row.text)} bytes</small><pre>${escapeHtml(row.text)}</pre></article>`
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
      return `<article id="node-${row.start}-${row.count}"><h3>${row.start}+${row.count} · level ${Math.log2(row.count)}</h3><small>${row.bytes} bytes · ${children}</small><pre>${escapeHtml(row.text)}</pre></article>`
    }
    return `<article><h3>${escapeHtml(row.path)} · revision ${row.id}</h3><a href="#message-${row.source_id}">Source message ${row.source_id}</a><pre>${escapeHtml(row.body)}</pre></article>`
  }

  const output = Stream.concat(
    Stream.concat(
      Stream.fromIterable(header()),
      archive(until).pipe(Stream.map(renderRow))
    ),
    Stream.succeed(
      html ? "</html>" : JSON.stringify({ type: "end", until }) + "\n"
    )
  ).pipe(Stream.map((text) => new TextEncoder().encode(text)))
  return new Response(yield* Stream.toReadableStreamEffect(output), {
    headers: {
      "content-type": html
        ? "text/html; charset=utf-8"
        : "application/x-ndjson",
      "content-disposition": `attachment; filename="pi-memory-${created.slice(0, 10)}.${html ? "html" : "jsonl"}"`,
      "cache-control": "private, no-store",
      "content-security-policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox",
    },
  })
})

const Header = Schema.Struct({
  type: Schema.Literal("header"),
  format: Schema.Literal("durable-pi-memory"),
  version: Schema.Literal(1),
  parts: Schema.Array(PartSchema),
  until: WatermarkSchema,
})
const Footer = Schema.Struct({
  type: Schema.Literal("end"),
  until: WatermarkSchema,
})
const decodeHeader = Schema.decodeUnknownEffect(Schema.fromJsonString(Header))
const decodeFooter = Schema.decodeUnknownEffect(Schema.fromJsonString(Footer))
const decodeRecord = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ArchiveRecord)
)
export const parseArchive = Effect.fn("Memory.parseArchive")(
  function* (jsonl: string) {
    const lines = jsonl.trim().split(/\r?\n/)
    const header = yield* decodeHeader(lines.shift() ?? "null")
    const footer = yield* decodeFooter(lines.pop() ?? "null")
    const records = yield* Effect.forEach(lines, (line) => decodeRecord(line))
    const actual = advance(emptyWatermark, records)
    for (const key of ["messages", "nodes", "notes"] as const)
      if (
        header.until[key] !== footer.until[key] ||
        actual[key] !== header.until[key]
      )
        return yield* new InvalidMemory({ message: "Incomplete archive" })
    return { records, parts: [...header.parts] }
  },
  Effect.catchTag(
    "SchemaError",
    () => new InvalidMemory({ message: "Invalid archive format" })
  )
)
