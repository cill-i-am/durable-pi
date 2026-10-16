import { Schema } from "effect"

import type { ResolvedRoute } from "../inference/policy"
import { AttachmentContent } from "../workspace/files"
import { DelegateInput, DelegationFailure } from "./contracts"

export const CHILD_LIMIT = 3
export const REQUEST_LIMIT = 12
export const DURATION_MS = 10 * 60_000
export const REPORT_BYTES = 36_000

export type DelegationSource = {
  turnId: string
  conversationId: number
  taskId: number
  route: ResolvedRoute
  memory: string
}
export function validateBrief(input: unknown): DelegateInput {
  let brief: DelegateInput
  try {
    brief = Schema.decodeUnknownSync(DelegateInput)(input)
  } catch {
    throw new DelegationFailure({
      code: "invalid",
      message: "Provide one to three named tasks with supported read tools.",
    })
  }
  const names = new Set<string>()
  for (const task of brief.tasks) {
    const name = task.name.trim().toLowerCase()
    if (!name || !task.task.trim() || names.has(name))
      throw new DelegationFailure({
        code: "invalid",
        message:
          "Each delegated task needs a distinct name and a concrete brief.",
      })
    names.add(name)
    if (new Set(task.tools).size !== task.tools.length)
      throw new DelegationFailure({
        code: "invalid",
        message: "Select each child tool once.",
      })
  }
  if (!brief.objective.trim())
    throw new DelegationFailure({
      code: "invalid",
      message: "Describe the outcome these tasks support.",
    })
  return brief
}

export function sharedReference(prompt: string): string {
  const contents = prompt.startsWith("[")
    ? Schema.decodeUnknownSync(Schema.Array(AttachmentContent))(
        JSON.parse(prompt)
      )
    : [{ type: "text" as const, text: prompt }]
  const text = contents
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
  const media = contents.some((part) => part.type === "image")
    ? "\n[Image/video pixels remain with the parent. Do not infer visual details; use supplied textual file references or report that parent inspection is needed.]"
    : ""
  if (new TextEncoder().encode(text).length > 64000)
    return (
      "The parent's reference view is too large to copy safely. Use the assigned brief and selected memory/file retrieval tools. Ask the parent to reconcile any missing requirements." +
      media
    )
  return text + media
}
