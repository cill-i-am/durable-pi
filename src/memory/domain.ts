import { Effect } from "effect"
import * as Schema from "effect/Schema"

import { MessageProvenance } from "../messages/identity"

export const NonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
export const LogKind = Schema.Literals(["user", "talk", "tool", "echo", "note"])
export type LogKind = typeof LogKind.Type
export const LogEntry = Schema.Struct({
  provenance: Schema.optional(MessageProvenance),
  id: NonNegativeInteger,
  source: Schema.String,
  kind: LogKind,
  text: Schema.String,
  date: Schema.String,
})
export type LogEntry = typeof LogEntry.Type
export const Part = Schema.Struct({
  start: NonNegativeInteger,
  count: NonNegativeInteger,
})
export type Part = typeof Part.Type
export const MemoryNode = Schema.Struct({
  ...Part.fields,
  text: Schema.String,
  bytes: NonNegativeInteger,
})
export type MemoryNode = typeof MemoryNode.Type
export type SummaryJob = Part & { source: string; context: string }
export const SummaryIssue = Schema.Struct({
  ...Part.fields,
  attempts: NonNegativeInteger,
  retryAt: Schema.NullOr(Schema.Number),
})
export type SummaryIssue = typeof SummaryIssue.Type
export const byteLength = (text: string) =>
  new TextEncoder().encode(text).length
export const nodeKey = ({ start, count }: Part) => `${start}+${count}`
export const validRange = ({ start, count }: Part, total: number) =>
  Number.isSafeInteger(start) &&
  Number.isSafeInteger(count) &&
  start >= 0 &&
  count > 0 &&
  Math.log2(count) % 1 === 0 &&
  start % count === 0 &&
  start + count <= total

export const NODE_BYTES = 512
export const VIEW_BYTES = 128_000

export const fitView = Effect.fn("Memory.fitView")(
  (
    parts: Part[],
    total: number,
    nodes: Map<string, MemoryNode>,
    budget: number
  ) =>
    Effect.sync(() => {
      // Adapted from VictorTaelin/UniiChat Memory.merge at 0500bf6,
      // Apache-2.0, Copyright 2026 Higher Order Company; see THIRD_PARTY_NOTICES.md.
      // Preserve merge priority and leftmost ties; discard stale heap entries.
      const view: (Part | null)[] = [...parts]
      const size = (part: Part) => nodes.get(nodeKey(part))?.bytes ?? 0
      let bytes = parts.reduce((sum, part) => sum + size(part), 0)
      const next = parts.map((_, k) => k + 1),
        previous = parts.map((_, k) => k - 1)
      type Candidate = { due: number; k: number; a: Part; b: Part }
      const heap: Candidate[] = []
      const above = (a: Candidate, b: Candidate) =>
        a.due > b.due || (a.due === b.due && a.k < b.k)
      const swap = (a: number, b: number) => {
        ;[heap[a], heap[b]] = [heap[b]!, heap[a]!]
      }
      const offer = (k: number) => {
        const a = view[k],
          b = view[next[k]!]
        if (
          !a ||
          !b ||
          a.count !== b.count ||
          a.start % (a.count * 2) !== 0 ||
          b.start !== a.start + a.count ||
          !nodes.has(nodeKey({ start: a.start, count: a.count * 2 }))
        )
          return
        heap.push({
          due: (total - (a.start + 2 * a.count - 1)) / a.count,
          k,
          a,
          b,
        })
        for (
          let x = heap.length - 1;
          x > 0 && above(heap[x]!, heap[(x - 1) >> 1]!);
          x = (x - 1) >> 1
        )
          swap(x, (x - 1) >> 1)
      }
      const take = () => {
        const top = heap[0]!,
          last = heap.pop()!
        if (heap.length) {
          heap[0] = last
          for (let x = 0; ;) {
            let best = x
            for (const child of [2 * x + 1, 2 * x + 2])
              if (child < heap.length && above(heap[child]!, heap[best]!))
                best = child
            if (best === x) break
            swap(x, best)
            x = best
          }
        }
        return top
      }
      parts.forEach((_, k) => offer(k))
      while (bytes > budget && heap.length) {
        const { k, a, b } = take(),
          j = next[k]!
        if (view[k] !== a || view[j] !== b) continue
        const parent = { start: a.start, count: a.count * 2 }
        bytes += size(parent) - size(a) - size(b)
        view[k] = parent
        view[j] = null
        next[k] = next[j]!
        if (next[j]! < view.length) previous[next[j]!] = k
        offer(previous[k]!)
        offer(k)
      }
      return view.filter((part): part is Part => part !== null)
    })
)

export class MemoryStorageError extends Schema.TaggedError<MemoryStorageError>()(
  "MemoryStorageError",
  {
    operation: Schema.String,
  }
) {
  override get message() {
    return `Memory storage failed during ${this.operation}`
  }
}
export class InvalidMemory extends Schema.TaggedError<InvalidMemory>()(
  "InvalidMemory",
  {
    message: Schema.String,
  }
) {}
export class MemoryNotReady extends Schema.TaggedError<MemoryNotReady>()(
  "MemoryNotReady",
  {}
) {
  override get message() {
    return "Memory is still being summarized"
  }
}
export type MemoryError = MemoryStorageError | InvalidMemory | MemoryNotReady
export const MemoryNote = Schema.Struct({
  path: Schema.String,
  body: Schema.String,
  source_id: NonNegativeInteger,
  updated_at: Schema.String,
})
export type MemoryNote = typeof MemoryNote.Type
