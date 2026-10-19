import { Effect } from "effect"

import { attributedText } from "../messages/identity"
import {
  byteLength,
  fitView,
  InvalidMemory,
  MemoryNotReady,
  VIEW_BYTES,
  nodeKey,
  validRange,
  type LogEntry,
  type MemoryNode,
  type Part,
} from "./domain"
import type { ArchiveRecord } from "./records"

export const SUMMARY_FAILURES = 3
export const summaryChildren = (part: Part): Part[] =>
  part.count === 1
    ? []
    : [
        { start: part.start, count: part.count / 2 },
        { start: part.start + part.count / 2, count: part.count / 2 },
      ]
export const summaryParent = (part: Part): Part => ({
  start: Math.floor(part.start / (part.count * 2)) * part.count * 2,
  count: part.count * 2,
})
export function summarySavePlan(part: Part, text: string, total: number) {
  if (!text.trim()) throw new InvalidMemory({ message: "Empty memory summary" })
  if (!validRange(part, total))
    throw new InvalidMemory({
      message: "Invalid summary range or missing children",
    })
  return {
    bytes: byteLength(text),
    children: summaryChildren(part),
    parent: summaryParent(part),
  }
}
export function requireSummaryChildren(
  children: readonly (MemoryNode | undefined)[]
) {
  if (children.some((child) => !child))
    throw new InvalidMemory({
      message: "Invalid summary range or missing children",
    })
}
export const parentReady = (
  exists: boolean,
  children: readonly (MemoryNode | undefined)[]
) => !exists && children.length === 2 && children.every(Boolean)
export const validNotePath = (path: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9_/-]*\.md$/.test(path) && !path.includes("..")
export function requireMemoryNote(
  path: string,
  body: string,
  sourceExists: boolean
) {
  if (!validNotePath(path) || body.length > 16000 || !sourceExists)
    throw new InvalidMemory({ message: "Invalid memory note" })
}
const viewBytes = (
  parts: readonly Part[],
  nodes: ReadonlyMap<string, MemoryNode>
) =>
  parts.reduce((sum, part) => sum + (nodes.get(nodeKey(part))?.bytes ?? 0), 0)
export const shouldFitMemory = (
  parts: readonly Part[],
  nodes: ReadonlyMap<string, MemoryNode>,
  compacting: boolean,
  budget: number
) => compacting || viewBytes(parts, nodes) > budget
export function memoryAncestors(parts: readonly Part[], total: number): Part[] {
  const ancestors = new Map<string, Part>()
  for (const part of parts) {
    if (!validRange(part, total))
      throw new Error("Memory view contains an invalid persisted range")
    for (let count = part.count; count <= total; count *= 2) {
      const ancestor = { start: Math.floor(part.start / count) * count, count }
      ancestors.set(nodeKey(ancestor), ancestor)
    }
  }
  return [...ancestors.values()]
}
export const fitMemory = Effect.fn("Memory.fit")(function* (
  parts: Part[],
  total: number,
  nodes: Map<string, MemoryNode>,
  budget: number
) {
  const target = budget / 2,
    view = yield* fitView(parts, total, nodes, target)
  return {
    view,
    compacting: viewBytes(view, nodes) > target,
    changed: view.length !== parts.length,
  }
})
export function summaryFailure(previous: number | undefined, retryAt: number) {
  return {
    attempts: Math.min(SUMMARY_FAILURES, (previous ?? 0) + 1),
    retryAt,
    first: previous === undefined,
  }
}
export type MergeSource = Part & { left_text: string; right_text: string }
export function summaryJob(
  leaves: readonly LogEntry[],
  parents: readonly MergeSource[],
  busy: ReadonlySet<string>,
  view: readonly MemoryNode[]
) {
  const leaf = leaves.find(
    (entry) => !busy.has(nodeKey({ start: entry.id, count: 1 }))
  )
  const parent = leaf
    ? undefined
    : parents.find((part) => !busy.has(nodeKey(part)))
  if (!leaf && !parent) return
  const start = leaf ? leaf.id : parent!.start,
    count = leaf ? 1 : parent!.count,
    end = leaf ? start : start + count
  return {
    start,
    count,
    source: leaf
      ? `${leaf.kind}: ${leaf.provenance ? attributedText(leaf.text, leaf.provenance) : leaf.text}`
      : `${parent!.left_text}\n${parent!.right_text}`,
    context: view
      .filter((part) => part.start + part.count <= end)
      .map((part) => `${nodeKey(part)}|${part.text.replaceAll("\n", " ")}`)
      .join("\n"),
  }
}
function memoryExcerpt(text: string, budget: number) {
  const marker = "\n[… excerpt omitted; use zoom for the full entry …]\n"
  const bytes = new TextEncoder().encode(text)
  const available = Math.max(0, budget - byteLength(marker))
  const headBytes = Math.floor(available / 2)
  let tailStart = bytes.length - (available - headBytes)
  while ((bytes[tailStart]! & 0xc0) === 0x80) tailStart++
  const decoder = new TextDecoder()
  const head = decoder.decode(bytes.subarray(0, headBytes), { stream: true })
  const tail = new TextDecoder().decode(bytes.subarray(tailStart))
  return head + marker + tail
}

// Pending summaries must not turn large tool results into unbounded input.
// Keep ordinary messages exact, preserve the saved-summary prefix, and give
// recent originals a separate allowance while their background work catches up.
export const PENDING_ORIGINAL_BYTES = 8_192
export const ORIGINAL_EXCERPT_BYTES = 4_096
const abbreviatedContext =
  "[Working context is abbreviated. Use search_memory or zoom to retrieve full archived entries.]"
const memoryLine = (part: Part, node: MemoryNode) =>
  `${nodeKey(part)}|${node.text.replaceAll("\n", " ")}`
export function pendingOriginalAllowance(
  parts: readonly Part[],
  nodes: ReadonlyMap<string, MemoryNode>
) {
  const savedBytes = parts.reduce((sum, part) => {
    const node = nodes.get(nodeKey(part))
    return sum + (node ? byteLength(memoryLine(part, node)) + 1 : 0)
  }, 0)
  const framingBytes = byteLength(`<chat>\n${abbreviatedContext}\n</chat>`) + 1
  return Math.max(
    0,
    Math.min(PENDING_ORIGINAL_BYTES, VIEW_BYTES - savedBytes - framingBytes)
  )
}
export function pendingOriginalLine(
  entry: Pick<LogEntry, "id" | "kind" | "text">,
  available: number
) {
  const line = `${entry.id}+0|${entry.kind}: ${entry.text}`
  const budget = Math.min(ORIGINAL_EXCERPT_BYTES, available)
  const abbreviated = byteLength(line) > budget
  return {
    abbreviated,
    rendered:
      budget < 128
        ? undefined
        : abbreviated
          ? memoryExcerpt(line, budget)
          : line,
  }
}
function pendingOriginals(
  parts: readonly Part[],
  nodes: ReadonlyMap<string, MemoryNode>,
  originals: ReadonlyMap<number, LogEntry>,
  omitted: ReadonlyMap<number, boolean>
) {
  const lines = new Map<number, string>()
  const abbreviated = new Set<number>()
  let available = pendingOriginalAllowance(parts, nodes)
  for (const part of [...parts].reverse()) {
    if (nodes.has(nodeKey(part))) continue
    if (omitted.has(part.start)) {
      if (omitted.get(part.start)) abbreviated.add(part.start)
      continue
    }
    const entry = originals.get(part.start)
    if (part.count !== 1 || !entry)
      throw new Error("Memory lost a committed working-context part")
    const selected = pendingOriginalLine(entry, available)
    if (selected.abbreviated) abbreviated.add(part.start)
    if (selected.rendered !== undefined) {
      lines.set(part.start, selected.rendered)
      available -= byteLength(selected.rendered) + 1
    }
  }
  return { lines, abbreviated }
}

/** Summaries optimize working context; committed originals fill unfinished
 * leaves. Abbreviation changes only this prompt, never the durable archive. */
export function renderMemory(
  parts: readonly Part[],
  nodes: ReadonlyMap<string, MemoryNode>,
  originals: ReadonlyMap<number, LogEntry>,
  omitted: ReadonlyMap<number, boolean> = new Map()
) {
  const pending = pendingOriginals(parts, nodes, originals, omitted)
  let noted = false
  const lines = parts.flatMap((part) => {
    const node = nodes.get(nodeKey(part))
    if (node) return [memoryLine(part, node)]
    const line = pending.lines.get(part.start)
    const notice = !noted && pending.abbreviated.has(part.start)
    if (notice) noted = true
    return [...(notice ? [abbreviatedContext] : []), ...(line ? [line] : [])]
  })
  const full = `<chat>\n${lines.join("\n")}\n</chat>`
  if (byteLength(full) <= VIEW_BYTES) return full
  const prefix = `<chat>\n${abbreviatedContext}\n`
  const suffix = "\n</chat>"
  let available = VIEW_BYTES - byteLength(prefix + suffix)
  const kept: string[] = []
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    const separator = kept.length ? 1 : 0
    if (byteLength(line) + separator > available) {
      if (available > 128) kept.push(memoryExcerpt(line, available - separator))
      break
    }
    kept.push(line)
    available -= byteLength(line) + separator
  }
  return prefix + kept.reverse().join("\n") + suffix
}
export function requireMemoryRange(part: Part, total: number) {
  if (!validRange(part, total))
    throw new InvalidMemory({ message: "No such memory range" })
}
export function zoomMemory(
  part: Part,
  entry: LogEntry | undefined,
  children: readonly (MemoryNode | undefined)[]
) {
  if (part.count === 1) {
    if (!entry) throw new Error("Memory lost a validated original message")
    return `${part.start}+0|${entry.kind}: ${entry.provenance ? attributedText(entry.text, entry.provenance) : entry.text}`
  }
  return children
    .map((child) => {
      if (!child) throw new MemoryNotReady()
      return `${nodeKey(child)}|${child.text}`
    })
    .join("\n")
}
export function memoryRestorePlan(
  records: readonly ArchiveRecord[],
  parts: readonly Part[]
) {
  const messages = records
    .filter((record) => record.type === "message")
    .sort((a, b) => a.id - b.id)
  const nodes = records
    .filter((record) => record.type === "node")
    .sort((a, b) => a.seq - b.seq)
  const notes = records
    .filter((record) => record.type === "note")
    .sort((a, b) => a.id - b.id)
  const sources = new Set<string>()
  messages.forEach((record, id) => {
    if (record.id !== id)
      throw new InvalidMemory({
        message: "Archive message IDs are not contiguous",
      })
    if (!Number.isFinite(Date.parse(record.date)))
      throw new InvalidMemory({ message: "Invalid message date" })
    if (sources.has(record.source))
      throw new InvalidMemory({ message: "Duplicate archive source" })
    sources.add(record.source)
  })
  const built = new Map<string, MemoryNode>()
  nodes.forEach((record, index) => {
    if (
      !validRange(record, messages.length) ||
      record.bytes !== byteLength(record.text)
    )
      throw new InvalidMemory({ message: "Invalid summary range or size" })
    if (summaryChildren(record).some((child) => !built.has(nodeKey(child))))
      throw new InvalidMemory({ message: "Missing summary children" })
    if (record.seq !== index + 1 || built.has(nodeKey(record)))
      throw new InvalidMemory({ message: "Duplicate summary" })
    built.set(nodeKey(record), record)
  })
  notes.forEach((record, index) => {
    if (record.id !== index + 1 || !Number.isFinite(Date.parse(record.date)))
      throw new InvalidMemory({ message: "Invalid note revision" })
    requireMemoryNote(
      record.path,
      record.body,
      messages.some((message) => message.id === record.source_id)
    )
  })
  let end = 0
  for (const part of parts) {
    if (
      part.start !== end ||
      !validRange(part, messages.length) ||
      (part.count > 1 && !built.has(nodeKey(part)))
    )
      throw new InvalidMemory({ message: "Invalid archive view" })
    end += part.count
  }
  if (end !== messages.length)
    throw new InvalidMemory({
      message: "Archive view does not cover its messages",
    })
  return { messages, nodes, notes, parts }
}
