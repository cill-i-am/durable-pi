import * as Schema from "effect/Schema"

import {
  LogEntry,
  MemoryNode,
  NonNegativeInteger,
  Part,
  byteLength,
  MemoryNote,
  SummaryIssue,
} from "./domain"
import { SUMMARY_FAILURES, validNotePath } from "./policy"

const Integer = NonNegativeInteger
const alignedPart = (part: Part) =>
  part.count > 0 &&
  Math.log2(part.count) % 1 === 0 &&
  part.start % part.count === 0
export const StoredPart = Part.check(Schema.makeFilter(alignedPart))
export const StoredNode = MemoryNode.check(
  Schema.makeFilter(
    (node) => alignedPart(node) && node.bytes === byteLength(node.text)
  )
)
export const StoredFailure = Schema.Struct({
  ...Part.fields,
  attempts: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(SUMMARY_FAILURES)
  ),
  retry_at: Schema.Number,
}).check(Schema.makeFilter(alignedPart))
export const StoredMerge = Schema.Struct({
  ...Part.fields,
  left_text: Schema.String,
  right_text: Schema.String,
}).check(Schema.makeFilter(alignedPart))
export const StoredNote = MemoryNote.check(
  Schema.makeFilter(
    (note) => validNotePath(note.path) && note.body.length <= 16000
  )
)
export const StoredIssue = SummaryIssue.check(
  Schema.makeFilter(
    (issue) =>
      alignedPart(issue) &&
      issue.attempts >= 1 &&
      issue.attempts <= SUMMARY_FAILURES
  )
)
export const StoredCount = Schema.Struct({ n: Integer })
export const StoredViewState = Schema.Struct({
  compacting: Schema.Literals([0, 1]),
})
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

export const StoredArchiveRecord = Schema.Union([
  MessageRecord,
  NodeRecord.check(
    Schema.makeFilter(
      (node) => alignedPart(node) && node.bytes === byteLength(node.text)
    )
  ),
  NoteRecord.check(
    Schema.makeFilter(
      (note) => validNotePath(note.path) && note.body.length <= 16000
    )
  ),
])
