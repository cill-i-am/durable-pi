import type { EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable"

import type { MessageProvenance } from "../../messages/identity"
import type { FileInfo } from "../../workspace/files"
import type { TimelineItem } from "../contracts"

export function piTimeline(
  entries: readonly EntryRecord[],
  live?: SnapshotEvent,
  steers: ReadonlyMap<
    number,
    {
      id: string
      text: string
      created_at?: string
      attachments?: readonly FileInfo[]
      provenance?: MessageProvenance
    }
  > = new Map()
): TimelineItem[] {
  const items: TimelineItem[] = []
  const tools = new Map<string, MutableTool>()
  const messages = entries.flatMap((entry) =>
    (entry.model ?? []).map((message, index) => ({
      entryId: entry.id,
      id: `${entry.id}:${index}`,
      message,
    }))
  )
  if (live?.generation?.message)
    messages.push({
      entryId: -1 as EntryRecord["id"],
      id: "partial",
      message: live.generation.message,
    })
  let assistantIndex = 0
  for (const { message, entryId } of messages) {
    if (message.role === "user") {
      const steer = steers.get(entryId)
      if (steer)
        items.push({
          id: `steer:${steer.id}`,
          type: "steer",
          text: steer.text,
          created_at: steer.created_at,
          attachments: steer.attachments,
          provenance: steer.provenance,
        })
    }
    if (message.role === "assistant") {
      const id = `assistant:${assistantIndex++}`
      message.content.forEach((block, index) => {
        if (block.type === "text" && block.text)
          items.push({
            id: `${id}:${index}`,
            type: "text",
            text: block.text,
            created_at: new Date(message.timestamp).toISOString(),
          })
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
  mergeLiveTools(tools, live)
  return boundedActivity(items)
}

const earlierActivity =
  "Earlier messages and tool results are available through memory search and retrieval."
const shortened =
  "\n[Display shortened; the full original is available through memory retrieval.]"

function boundedActivity(items: readonly TimelineItem[]): TimelineItem[] {
  const encoder = new TextEncoder(),
    kept: TimelineItem[] = []
  let bytes = 2
  for (let index = items.length - 1; index >= 0; index--) {
    let item = items[index]!
    if ("text" in item && item.text.length > 32_000)
      item = {
        ...item,
        text:
          item.text.slice(0, 32_000) +
          (item.type === "thinking"
            ? "\n[Reasoning display shortened.]"
            : shortened),
      }
    const size = encoder.encode(JSON.stringify(item)).length + 1
    if (bytes + size > 511_000) {
      kept.push({ id: "earlier-activity", type: "text", text: earlierActivity })
      break
    }
    bytes += size
    kept.push(item)
  }
  return kept.reverse()
}

export function displayAnswer(entries: readonly EntryRecord[]) {
  const parts: string[] = []
  let remaining = 120_000
  for (let index = entries.length - 1; index >= 0; index--) {
    const messages = entries[index]!.model ?? []
    for (let position = messages.length - 1; position >= 0; position--) {
      const message = messages[position]!
      if (message.role !== "assistant") continue
      const value = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
      if (!value) continue
      if (value.length > remaining) {
        if (remaining) parts.push(value.slice(-remaining))
        parts.push(earlierActivity)
        return parts.reverse().join("\n\n")
      }
      parts.push(value)
      remaining = Math.max(0, remaining - value.length - 2)
    }
  }
  return parts.reverse().join("\n\n")
}

type Tool = Extract<TimelineItem, { type: "tool" }>
type MutableTool = { -readonly [K in keyof Tool]: Tool[K] }

function mergeLiveTools(tools: Map<string, MutableTool>, live?: SnapshotEvent) {
  for (const slot of live?.tools ?? []) {
    const tool = tools.get(slot.callId)
    if (tool && slot.status === "done" && !slot.entry) {
      tool.status = "error"
    } else if (tool && slot.status !== "done") {
      tool.status = slot.status === "pending" ? "pending" : "running"
      tool.output = slot.output?.slice(-32_000) ?? tool.output
    }
  }
}
