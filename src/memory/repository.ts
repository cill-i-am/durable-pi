import { Context, type Effect } from "effect"
import type {
  LogEntry,
  LogKind,
  MemoryError,
  MemoryNode,
  MemoryNote,
  Part,
  SummaryJob,
} from "./domain"
import type { ArchiveRecord, Watermark } from "./records"

/**
 * Memory owns immutable history, its summary tree, view and sourced notes.
 * Conversation/session state, model SDKs, SQL and backup transports are not
 * part of this contract. Each mutation is atomic, including restore/import.
 */
export class MemoryRepository extends Context.Service<
  MemoryRepository,
  {
    append: (
      source: string,
      kind: LogKind,
      text: string,
      date?: string
    ) => Effect.Effect<LogEntry, MemoryError>
    total: () => Effect.Effect<number, MemoryError>
    parts: () => Effect.Effect<Part[], MemoryError>
    node: (part: Part) => Effect.Effect<MemoryNode | undefined, MemoryError>
    nodeCount: () => Effect.Effect<number, MemoryError>
    entry: (id: number) => Effect.Effect<LogEntry | undefined, MemoryError>
    saveNode: (part: Part, text: string) => Effect.Effect<void, MemoryError>
    failNode: (
      part: Part,
      retryAt: number
    ) => Effect.Effect<boolean, MemoryError>
    retryAt: () => Effect.Effect<number | undefined, MemoryError>
    next: (
      busy?: Set<string>,
      now?: number
    ) => Effect.Effect<SummaryJob | undefined, MemoryError>
    settled: () => Effect.Effect<boolean, MemoryError>
    render: () => Effect.Effect<string, MemoryError>
    zoom: (start: number, count: number) => Effect.Effect<string, MemoryError>
    search: (query: string) => Effect.Effect<LogEntry[], MemoryError>
    notes: () => Effect.Effect<MemoryNote[], MemoryError>
    writeNote: (
      path: string,
      body: string,
      sourceId: number
    ) => Effect.Effect<void, MemoryError>
    watermark: () => Effect.Effect<Watermark, MemoryError>
    snapshot: () => Effect.Effect<
      {
        until: Watermark
        parts: Part[]
        view: (Part & { text: string | undefined; built: boolean })[]
      },
      MemoryError
    >
    archivePage: (
      after: Watermark,
      until: Watermark,
      limit?: number
    ) => Effect.Effect<ArchiveRecord[], MemoryError>
    restore: (
      records: readonly ArchiveRecord[],
      parts: readonly Part[]
    ) => Effect.Effect<void, MemoryError>
    importEntries: (
      id: string,
      records: readonly { kind: LogKind; text: string; date: string }[]
    ) => Effect.Effect<number, MemoryError>
  }
>()("durable-pi/memory/MemoryRepository") {}
