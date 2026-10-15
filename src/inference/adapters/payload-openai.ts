import * as Schema from "effect/Schema"

export const CACHE_MARKS = [50_000, 80_000, 100_000] as const
const record = Schema.decodeUnknownSync(
  Schema.Record(Schema.String, Schema.Unknown)
)
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function viewBlocks(text: string) {
  let start = 0
  const blocks: {
    type: "input_text"
    text: string
    prompt_cache_breakpoint?: { mode: "explicit" }
  }[] = []
  for (const mark of CACHE_MARKS) {
    if (mark >= text.length) continue
    const end = text.lastIndexOf("\n", mark - 1) + 1
    if (end <= start) continue
    blocks.push({
      type: "input_text",
      text: text.slice(start, end),
      prompt_cache_breakpoint: { mode: "explicit" },
    })
    start = end
  }
  blocks.push({ type: "input_text", text: text.slice(start) })
  return blocks
}

export function memoryPayload(payload: unknown) {
  const body = record(payload)
  const input = Array.isArray(body.input)
    ? body.input.map((item) => {
        if (
          !isRecord(item) ||
          item.role !== "user" ||
          !Array.isArray(item.content)
        )
          return item
        return {
          ...item,
          content: item.content.flatMap((part) => {
            if (
              !isRecord(part) ||
              part.type !== "input_text" ||
              typeof part.text !== "string" ||
              !part.text.startsWith("<chat>\n")
            )
              return [part]
            const end = part.text.indexOf("\n</chat>")
            if (end < 0) return [part]
            const boundary = end + "\n</chat>".length
            const blocks = viewBlocks(part.text.slice(0, boundary))
            if (boundary < part.text.length)
              blocks.push({
                type: "input_text",
                text: part.text.slice(boundary),
              })
            return blocks
          }),
        }
      })
    : body.input
  return {
    ...body,
    input,
    store: false,
    ...(isRecord(body.reasoning)
      ? { reasoning: { ...body.reasoning, context: "all_turns" } }
      : {}),
  }
}
