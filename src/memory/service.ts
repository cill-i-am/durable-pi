import { Clock, Effect, Layer } from "effect"

import type { MemoryError } from "./domain"
import type { MemoryLedger } from "./ledger"
import { MemoryRepository } from "./repository"

export function makeMemoryRepository(
  storage: MemoryLedger
): typeof MemoryRepository.Service {
  const read = <T>(
    operation: string,
    body: () => Effect.Effect<T, MemoryError>
  ) => Effect.suspend(body).pipe(Effect.withSpan(`Memory.${operation}`))
  const date = Clock.currentTimeMillis.pipe(
    Effect.map((now) => new Date(now).toISOString())
  )
  const repository = MemoryRepository.of({
    append: Effect.fn("Memory.append")(
      function* (source, kind, text, at, provenance) {
        const timestamp = at ?? (yield* date)
        return yield* read("append", () =>
          storage.append(source, kind, text, timestamp, provenance)
        )
      }
    ),
    total: () => read("total", () => storage.total()),
    parts: () => read("parts", () => storage.parts()),
    node: (part) => read("node", () => storage.node(part)),
    nodeCount: () => read("nodeCount", () => storage.nodeCount()),
    entry: (id) => read("entry", () => storage.entry(id)),
    saveNode: (part, text, claim) =>
      read("saveNode", () => storage.saveNode(part, text, claim)),
    failNode: (part, retryAt, claim) =>
      read("failNode", () => storage.failNode(part, retryAt, claim)),
    claimSummary: (part, now) =>
      read("claimSummary", () => storage.claimSummary(part, now)),
    pauseSummary: (claim) =>
      read("pauseSummary", () => storage.pauseSummary(claim)),
    restoreSummaryClaims: () =>
      read("restoreSummaryClaims", () => storage.restoreSummaryClaims()),
    retryAt: () => read("retryAt", () => storage.retryAt()),
    issues: () => read("issues", () => storage.issues()),
    paused: (part) => read("paused", () => storage.paused(part)),
    retrySummary: (part, admission) =>
      read("retrySummary", () => storage.retrySummary(part, admission)),
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
        storage.atomic(() =>
          Effect.gen(function* () {
            const until = yield* storage.watermark(),
              parts = yield* storage.parts()
            const view = yield* Effect.forEach(parts, (part) =>
              storage.node(part).pipe(
                Effect.map((node) => ({
                  ...part,
                  text: node?.text,
                  built: !!node,
                }))
              )
            )
            return { until, parts, view }
          })
        )
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
