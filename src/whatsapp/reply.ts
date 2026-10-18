import { splitReply, type ReplyPart } from "../replies/contracts"

export function whatsappReply(
  text: string,
  name: string,
  reviewUrl: string,
  files: readonly string[] = []
): ReplyPart[] {
  const prefix = `${name}\n\n`
  const footer = `\n\n${reviewUrl}`
  const chunks = splitReply(text, 3900 - prefix.length - footer.length)
  return [
    ...chunks.map((chunk, index) => ({
      text: `${prefix}${chunk}${index === chunks.length - 1 ? footer : ""}`,
      files: [],
    })),
    ...files.map((id) => ({ text: "", files: [id] })),
  ]
}
