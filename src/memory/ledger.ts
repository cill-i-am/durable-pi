import { Context } from "effect"
import type { ArchiveRecord, Watermark } from "./records"
import type {
  LogEntry,
  LogKind,
  MemoryNote,
  Part,
  MemoryNode,
  SummaryJob,
  SummaryIssue,
} from "./domain"

/** Owned synchronous persistence contract. Native transactions preserve Memory
 * publication, restore, retry and cross-context journal atomicity; application
 * callers compose the corresponding Effect operations. */
export interface MemoryLedger {
  readonly transactionGroup: object
  atomic: <T>(body: () => T) => T
  paused: (part: Part) => boolean
  retrySummary: (part: Part) => boolean
  append: (
    source: string,
    kind: LogKind,
    text: string,
    date: string
  ) => LogEntry
  render: () => string
  notes: () => MemoryNote[]
  total: () => number
  parts: () => Part[]
  node: (part: Part) => MemoryNode | undefined
  nodeCount: () => number
  entry: (id: number) => LogEntry | undefined
  saveNode: (part: Part, text: string) => void
  failNode: (part: Part, retryAt: number) => boolean
  retryAt: () => number | undefined
  issues: () => SummaryIssue[]
  next: (busy: Set<string>, now: number) => SummaryJob | undefined
  blocked: () => boolean
  settled: () => boolean
  zoom: (start: number, count: number) => string
  search: (query: string) => LogEntry[]
  writeNote: (
    path: string,
    body: string,
    sourceId: number,
    date: string
  ) => void
  watermark: () => Watermark
  archivePage: (
    after: Watermark,
    until: Watermark,
    limit?: number
  ) => ArchiveRecord[]
  restore: (records: readonly ArchiveRecord[], parts: readonly Part[]) => void
  importEntries: (
    id: string,
    records: readonly { kind: LogKind; text: string; date: string }[]
  ) => number
}
export class MemoryTransaction extends Context.Service<
  MemoryTransaction,
  MemoryLedger
>()("durable-pi/memory/MemoryTransaction") {}
