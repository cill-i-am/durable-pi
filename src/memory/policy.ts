import {
  byteLength,
  fitView,
  InvalidMemory,
  MemoryNotReady,
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
export function fitMemory(
  parts: Part[],
  total: number,
  nodes: Map<string, MemoryNode>,
  budget: number
) {
  const target = budget / 2,
    view = fitView(parts, total, nodes, target)
  return {
    view,
    compacting: viewBytes(view, nodes) > target,
    changed: view.length !== parts.length,
  }
}
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
      ? `${leaf.kind}: ${leaf.text}`
      : `${parent!.left_text}\n${parent!.right_text}`,
    context: view
      .filter((part) => part.start + part.count <= end)
      .map((part) => `${nodeKey(part)}|${part.text.replaceAll("\n", " ")}`)
      .join("\n"),
  }
}
export function renderMemory(view: readonly MemoryNode[], partCount: number) {
  if (view.length !== partCount) throw new MemoryNotReady()
  return `<chat>\n${view.map((part) => `${nodeKey(part)}|${part.text.replaceAll("\n", " ")}`).join("\n")}\n</chat>`
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
    return `${part.start}+0|${entry.kind}: ${entry.text}`
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
