import * as Schema from "effect/Schema"

export const NonNegativeInteger = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
export const LogKind = Schema.Literals(["user", "talk", "tool", "echo", "note"])
export type LogKind = typeof LogKind.Type
export const LogEntry = Schema.Struct({
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

/** Only merge aligned siblings. Persisted parts never split as new text arrives. */
export function fitView(
  parts: Part[],
  total: number,
  nodes: Map<string, MemoryNode>,
  budget: number
): Part[] {
  const view = [...parts]
  const size = (part: Part) => nodes.get(nodeKey(part))?.bytes ?? 0
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
      // Age is measured from the pair's LAST message. Measuring from its
      // first message rewrites old prefixes (notably at T=10).
      const due = (total - (a.start + 2 * a.count - 1)) / a.count
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
