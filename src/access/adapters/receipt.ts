import type { ToolExecutionResult } from "@earendil-works/pi-durable"

import type { RemoteToolResult } from "../connections"

export const piRemoteResult = (
  result: RemoteToolResult
): ToolExecutionResult => ({
  isError: result.isError,
  output: [...result.content],
  ...(result.diagnostics ? { diagnostics: [...result.diagnostics] } : {}),
})

type LegacyToolResult = Omit<ToolExecutionResult, "output"> & {
  readonly content: ToolExecutionResult["output"]
}

export function toolReceipt(
  stored: ToolExecutionResult | LegacyToolResult
): ToolExecutionResult {
  // Completed receipts from Pi 1.0 must replay without dispatching the tool again.
  const result: ToolExecutionResult =
    "content" in stored
      ? (({ content, ...rest }) => ({ ...rest, output: content }))(stored)
      : stored
  if (JSON.stringify(result).length <= 250_000) return result
  let remaining = 24_000
  const content: NonNullable<ToolExecutionResult["output"]>[number][] = []
  for (const block of (result.output ?? []).slice(0, 32)) {
    if (block.type === "text") {
      const text = block.text.slice(0, remaining)
      remaining -= text.length
      if (text) content.push({ type: "text", text })
    } else {
      const size = JSON.stringify(block).length
      if (size <= remaining) {
        content.push(block)
        remaining -= size
      }
    }
  }
  return {
    output: content,
    isError: result.isError,
    control:
      JSON.stringify(result.control ?? {}).length <= 8000
        ? result.control
        : undefined,
    usage:
      JSON.stringify(result.usage ?? {}).length <= 8000
        ? result.usage
        : undefined,
    diagnostics: [
      ...(result.diagnostics ?? []).slice(0, 16).map((value) => ({
        ...value,
        message: value.message.slice(0, 512),
        code: value.code?.slice(0, 80),
      })),
      {
        severity: "warn",
        code: "durable_output_truncated",
        message:
          "Tool result shortened for durable storage. Large image blocks and details may be omitted; use a narrower read.",
      },
    ],
  }
}
