import type { EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable"
import type { TimelineItem } from "../contracts"

/** Deliberately project display fields: never serialize provider tokens/signatures. */
export function piTimeline(
  entries: readonly EntryRecord[],
  live?: SnapshotEvent
): TimelineItem[] {
  const items: TimelineItem[] = []
  type Tool = Extract<TimelineItem, { type: "tool" }>
  type MutableTool = { -readonly [K in keyof Tool]: Tool[K] }
  const tools = new Map<string, MutableTool>()
  const messages = entries.flatMap((entry) =>
    (entry.model ?? []).map((message, index) => ({
      id: `${entry.id}:${index}`,
      message,
    }))
  )
  if (live?.generation?.message)
    messages.push({ id: "partial", message: live.generation.message })
  let assistantIndex = 0
  for (const { message } of messages) {
    if (message.role === "assistant") {
      // Sessions are append-only. The in-flight assistant occupies the same ordinal
      // as its eventual entry, keeping expanded disclosures and keyboard focus stable.
      const id = `assistant:${assistantIndex++}`
      message.content.forEach((block, index) => {
        if (block.type === "text" && block.text)
          items.push({ id: `${id}:${index}`, type: "text", text: block.text })
        if (block.type === "thinking" && block.thinking)
          items.push({
            id: `${id}:${index}`,
            type: "thinking",
            text: block.thinking,
          })
        if (block.type === "toolCall") {
          const item: MutableTool = {
            id: block.id,
            type: "tool",
            name: block.name,
            input: JSON.stringify(block.arguments, null, 2).slice(0, 16_000),
            output: "",
            status: live ? "running" : "interrupted",
          }
          tools.set(block.id, item)
          items.push(item)
        }
      })
    } else if (message.role === "toolResult") {
      const item = tools.get(message.toolCallId)
      if (item) {
        item.output = message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("\n")
          .slice(0, 32_000)
        item.status = message.isError ? "error" : "done"
      }
    }
  }
  for (const slot of live?.tools ?? []) {
    const tool = tools.get(slot.callId)
    if (tool && slot.status === "done" && !slot.entry) {
      tool.status = "error"
    } else if (tool && slot.status !== "done") {
      tool.status = slot.status === "pending" ? "pending" : "running"
      tool.output = slot.output?.slice(-32_000) ?? tool.output
    }
  }
  return items
}
