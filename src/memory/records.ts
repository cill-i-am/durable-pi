import * as Schema from "effect/Schema"
import { LogEntry, MemoryNode, NonNegativeInteger, Part } from "./domain"

const Integer = NonNegativeInteger
export const MessageRecord = Schema.Struct({
  type: Schema.Literal("message"),
  ...LogEntry.fields,
})
export const NodeRecord = Schema.Struct({
  type: Schema.Literal("node"),
  seq: Integer,
  ...MemoryNode.fields,
})
export const NoteRecord = Schema.Struct({
  type: Schema.Literal("note"),
  id: Integer,
  path: Schema.String,
  body: Schema.String,
  source_id: Integer,
  date: Schema.String,
})
export const ArchiveRecord = Schema.Union([
  MessageRecord,
  NodeRecord,
  NoteRecord,
])
export type ArchiveRecord = typeof ArchiveRecord.Type
export type Watermark = typeof WatermarkSchema.Type
export const emptyWatermark: Watermark = { messages: 0, nodes: 0, notes: 0 }

export const WatermarkSchema = Schema.Struct({
  messages: Integer,
  nodes: Integer,
  notes: Integer,
})
export const PartSchema = Part

export function advance(
  after: Watermark,
  records: readonly ArchiveRecord[]
): Watermark {
  const next = { ...after }
  for (const record of records) {
    if (record.type === "message")
      next.messages = Math.max(next.messages, record.id + 1)
    if (record.type === "node") next.nodes = Math.max(next.nodes, record.seq)
    if (record.type === "note") next.notes = Math.max(next.notes, record.id)
  }
  return next
}
