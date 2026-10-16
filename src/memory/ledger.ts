import type {
  MemoryError,
  MemoryStorageError,
  LogEntry,
  LogKind,
  MemoryNote,
  Part,
  MemoryNode,
  SummaryJob,
  SummaryIssue,
} from "./domain"
import type { Effect } from "effect"
import { Context } from "effect"
import type { ArchiveRecord, Watermark } from "./records"

/** Effect persistence operations participate in one native transaction group. */
export interface MemoryLedger {
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | MemoryStorageError, TRequirements>
  paused: (part: Part) => Effect.Effect<boolean, MemoryError>
  retrySummary: (part: Part) => Effect.Effect<boolean, MemoryError>
  append: (
    source: string,
    kind: LogKind,
    text: string,
    date: string
  ) => Effect.Effect<LogEntry, MemoryError>
  render: () => Effect.Effect<string, MemoryError>
  notes: () => Effect.Effect<MemoryNote[], MemoryError>
  total: () => Effect.Effect<number, MemoryError>
  parts: () => Effect.Effect<Part[], MemoryError>
  node: (part: Part) => Effect.Effect<MemoryNode | undefined, MemoryError>
  nodeCount: () => Effect.Effect<number, MemoryError>
  entry: (id: number) => Effect.Effect<LogEntry | undefined, MemoryError>
  saveNode: (part: Part, text: string) => Effect.Effect<void, MemoryError>
  failNode: (part: Part, retryAt: number) => Effect.Effect<boolean, MemoryError>
  retryAt: () => Effect.Effect<number | undefined, MemoryError>
  issues: () => Effect.Effect<SummaryIssue[], MemoryError>
  next: (
    busy: Set<string>,
    now: number
  ) => Effect.Effect<SummaryJob | undefined, MemoryError>
  blocked: () => Effect.Effect<boolean, MemoryError>
  settled: () => Effect.Effect<boolean, MemoryError>
  zoom: (start: number, count: number) => Effect.Effect<string, MemoryError>
  search: (query: string) => Effect.Effect<LogEntry[], MemoryError>
  writeNote: (
    path: string,
    body: string,
    sourceId: number,
    date: string
  ) => Effect.Effect<void, MemoryError>
  watermark: () => Effect.Effect<Watermark, MemoryError>
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
export class MemoryTransaction extends Context.Service<
  MemoryTransaction,
  MemoryLedger
>()("durable-pi/memory/MemoryTransaction") {}
