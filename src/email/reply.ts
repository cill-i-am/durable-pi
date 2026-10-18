import { fileBatches, type ReplyPart } from "../replies/contracts"

export function emailReply(
  text: string,
  reviewUrl: string,
  files: readonly { id: string; size: number }[]
): ReplyPart[] {
  const batches = fileBatches(files, 16 * 1024 * 1024)
  if (!batches.length) batches.push([])
  const footer = `\n\nView this agent in Pi: ${reviewUrl}`
  return batches.map((batch, index) => {
    const body = index === 0 ? text : "Additional files for your reply."
    return {
      text: body.endsWith(footer) ? body : body + footer,
      files: batch.map((file) => file.id),
    }
  })
}
