import { Schema, Clock, Effect, Layer } from "effect"
import { MemoryRepository } from "./repository"
import type { MemoryLedger } from "./ledger"
import { InvalidMemory, MemoryNotReady, MemoryStorageError } from "./domain"

export function makeMemoryRepository(
  storage: MemoryLedger
): typeof MemoryRepository.Service {
  const read = <T>(operation: string, body: () => T) =>
    Effect.fn(`Memory.${operation}`)(() =>
      Effect.try({
        try: body,
        catch: (error) => {
          const knownFailure = Schema.decodeUnknownOption(
            Schema.Union([InvalidMemory, MemoryNotReady, MemoryStorageError])
          )(error)
          if (knownFailure._tag === "Some") return knownFailure.value
          throw error
        },
      })
    )()
  const date = Clock.currentTimeMillis.pipe(
    Effect.map((now) => new Date(now).toISOString())
  )
  const repository = MemoryRepository.of({
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
    issues: () => read("issues", () => storage.issues()),
    paused: (part) => read("paused", () => storage.paused(part)),
    retrySummary: (part) =>
      read("retrySummary", () => storage.retrySummary(part)),
    next: (busy = new Set(), now) =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((current) =>
          read("next", () => storage.next(busy, now ?? current))
        )
      ),
    blocked: () => read("blocked", () => storage.blocked()),
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
      read("snapshot", () =>
        storage.atomic(() => {
          const until = storage.watermark(),
            parts = storage.parts()
          const view = parts.map((part) => {
            const node = storage.node(part)
            return { ...part, text: node?.text, built: !!node }
          })
          return { until, parts, view }
        })
      ),
    archivePage: (after, until, limit) =>
      read("archivePage", () => storage.archivePage(after, until, limit)),
    restore: (records, parts) =>
      read("restore", () => storage.restore(records, parts)),
    importEntries: (id, records) =>
      read("import", () => storage.importEntries(id, records)),
  })
  return repository
}
export const memoryApplication = (ledger: MemoryLedger) =>
  Layer.succeed(MemoryRepository, makeMemoryRepository(ledger))
