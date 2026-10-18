import { Schema } from "effect"

/** A frozen provider-call plan. File bytes remain in the private workspace. */
export const ReplyPart = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(Schema.String),
})
export type ReplyPart = typeof ReplyPart.Type
export const ReplyProgress = Schema.Struct({
  version: Schema.Literal(1),
  generation: Schema.Number,
  parts: Schema.Array(ReplyPart),
  receipts: Schema.Array(Schema.String),
})
export type ReplyProgress = typeof ReplyProgress.Type
export class ReplySendFailed extends Schema.TaggedError<ReplySendFailed>()(
  "ReplySendFailed",
  { uncertain: Schema.Boolean }
) {}
export const replyComplete = (progress?: ReplyProgress | null) =>
  !!progress &&
  progress.parts.length > 0 &&
  progress.receipts.length === progress.parts.length

/** Preserve every UTF-16 code unit without splitting a surrogate pair. */
export function splitReply(text: string, maximum: number): string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 2)
    throw new Error("Invalid reply text budget")
  const parts: string[] = []
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maximum, text.length)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}
export function fileBatches<T extends { size: number }>(
  files: readonly T[],
  maximum: number
): T[][] {
  const batches: T[][] = []
  let size = 0
  for (const file of files) {
    if (file.size > maximum)
      throw new Error("File exceeds the provider attachment budget")
    if (!batches.length || size + file.size > maximum) {
      batches.push([])
      size = 0
    }
    batches.at(-1)!.push(file)
    size += file.size
  }
  return batches
}
