import { Cause, Clock, Effect, Exit, Latch, Schema, Stream } from "effect"

import { preserveFatal } from "../../shared/effect"
import { memoryTree, MemoryImportBusy } from "../application"
import { archive } from "../archive"
import { byteLength, type MemoryError } from "../domain"
import type { ArchiveRecord } from "../records"
import { MemoryRepository } from "../repository"

export const memoryReadRequest = (
  request: Request,
  path: "tree" | "search" | "zoom"
) => {
  const query = new URL(request.url).searchParams
  if (path === "tree")
    return memoryTree(
      query.has("id")
        ? { start: Number(query.get("id")), count: Number(query.get("n")) }
        : undefined
    ).pipe(Effect.map((value) => Response.json(value)))
  return Effect.flatMap(MemoryRepository, (memory) =>
    path === "search"
      ? memory
          .search((query.get("q") ?? "").slice(0, 200))
          .pipe(Effect.map((value) => Response.json(value)))
      : memory
          .zoom(Number(query.get("id")), Number(query.get("n")))
          .pipe(Effect.map((value) => Response.json({ text: value })))
  )
}
export const memoryImportResponse = <TError, TRequirements>(
  program: Effect.Effect<
    { added: number },
    TError | MemoryImportBusy,
    TRequirements
  >
) =>
  program.pipe(
    Effect.map((value) => Response.json(value)),
    preserveFatal,
    Effect.catchTag("MemoryImportBusy", (cause) =>
      Effect.sync(() => {
        const busy = Schema.decodeUnknownSync(MemoryImportBusy)(cause)
        return Response.json({ error: busy.message }, { status: 409 })
      })
    )
  )

export type MemoryExportRunner = (
  program: Effect.Effect<void, MemoryError>,
  options: { signal: AbortSignal }
) => Promise<Exit.Exit<void, unknown>>

/** The response body owns production. Its host runner tracks that work for
 * actor shutdown; cancel joins it before releasing resources. */
function exportBody(
  output: Stream.Stream<Uint8Array, MemoryError>,
  options: { signal?: AbortSignal; run?: MemoryExportRunner }
): ReadableStream<Uint8Array> {
  const cancelled = new AbortController()
  const demand = Latch.makeUnsafe()
  let closed = false
  let pulled: (() => void) | undefined
  let task: Promise<Exit.Exit<void, unknown>> | undefined
  return new ReadableStream(
    {
      start(controller) {
        const program = output.pipe(
          Stream.runForEach((chunk) =>
            demand.whenOpen(
              Effect.sync(() => {
                demand.closeUnsafe()
                if (!closed) controller.enqueue(chunk)
                pulled?.()
                pulled = undefined
              })
            )
          ),
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)
              ? Effect.void
              : Cause.hasDies(exit.cause)
                ? Effect.logError("Memory.exportFailed")
                : Effect.logWarning("Memory.exportUnavailable")
          )
        )
        task = (options.run ?? Effect.runPromiseExit)(program, {
          signal: options.signal
            ? AbortSignal.any([options.signal, cancelled.signal])
            : cancelled.signal,
        })
        void task.then((exit) => {
          pulled?.()
          pulled = undefined
          if (closed) return
          closed = true
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause))
            controller.error(new Error("Memory export could not be completed."))
          else controller.close()
        })
      },
      pull() {
        return new Promise<void>((resolve) => {
          pulled = resolve
          demand.openUnsafe()
        })
      },
      async cancel() {
        closed = true
        cancelled.abort()
        const exit = await task
        if (exit && Exit.isFailure(exit) && Cause.hasDies(exit.cause))
          throw new Error("Memory export cleanup failed.")
      },
    },
    { highWaterMark: 1 }
  )
}

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!
  )

export const exportResponse = Effect.fn("Memory.export")(function* (
  html = false,
  options: { signal?: AbortSignal; run?: MemoryExportRunner } = {}
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
      yield (
        JSON.stringify({
          type: "header",
          format: "durable-pi-memory",
          version: 1,
          created,
          parts,
          until,
        }) + "\n"
      )
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
  const context = yield* Effect.context<MemoryRepository>()
  return new Response(
    exportBody(output.pipe(Stream.provideContext(context)), options),
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
})
