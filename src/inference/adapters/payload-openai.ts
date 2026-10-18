import * as Schema from "effect/Schema"

const record = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown)
)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
const VIEW_MESSAGE_CHARS = 4_000

/** Native message endings give implicit caching reusable boundaries. Keep
 * complete lines and never bisect Unicode or require provider-only fields. */
export function viewChunks(text: string) {
  const chunks: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + VIEW_MESSAGE_CHARS, text.length)
    if (end < text.length) {
      const previous = text.lastIndexOf("\n", end - 1) + 1
      const next = text.indexOf("\n", end)
      end = previous > start ? previous : next < 0 ? text.length : next + 1
    }
    chunks.push(text.slice(start, end))
    start = end
  }
  return chunks.length ? chunks : [""]
}
function memoryMessages(item: unknown) {
  if (!isRecord(item) || item.role !== "user" || !Array.isArray(item.content))
    return [item]
  const parts: readonly unknown[] = item.content
  const first = parts[0]
  if (
    !isRecord(first) ||
    first.type !== "input_text" ||
    typeof first.text !== "string" ||
    !first.text.startsWith("<chat>\n")
  )
    return [item]
  const end = first.text.indexOf("\n</chat>")
  if (end < 0) return [item]
  const messages: Record<string, unknown>[] = viewChunks(
    first.text.slice("<chat>\n".length, end)
  ).map((chunk) => ({
    ...item,
    content: [{ ...first, text: `<chat>\n${chunk}\n</chat>` }],
  }))
  const rest = first.text.slice(end + "\n</chat>".length)
  const content: unknown[] = [
    ...(rest ? [{ ...first, text: rest }] : []),
    ...parts.slice(1),
  ]
  if (content.length) messages.push({ ...item, content })
  return messages
}

export function memoryPayload(payload: unknown) {
  const body = record(payload)
  return {
    ...body,
    input: Array.isArray(body.input)
      ? body.input.flatMap(memoryMessages)
      : body.input,
    store: false,
    ...(isRecord(body.reasoning)
      ? { reasoning: { ...body.reasoning, context: "all_turns" } }
      : {}),
  }
}
