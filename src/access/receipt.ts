import { Schema } from "effect"

import type { ToolOperation } from "./ledger"

export interface ReceiptFact {
  id: string
  turnId: string
  revision: number
  tool: string
  status: ToolOperation["status"]
  outcome: "succeeded" | "failed" | "unavailable"
}
export interface ReceiptQuery {
  id: string
  revision: number
  roots: readonly string[]
}
export function scopedReceiptFact(
  operation: ToolOperation | undefined,
  query: ReceiptQuery
) {
  if (
    !operation ||
    operation.revision !== query.revision ||
    !query.roots.includes(operation.turnId)
  )
    return undefined
  return receiptFact(operation)
}
const Output = Schema.Array(
  Schema.Struct({
    type: Schema.String,
    text: Schema.optional(Schema.String),
  })
)
const Result = Schema.Struct({
  isError: Schema.optional(Schema.Boolean),
  content: Schema.optional(Output),
  output: Schema.optional(Output),
})
const ExecutionOutcome = Schema.Struct({
  status: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.Unknown),
  output: Schema.optional(
    Schema.Struct({ error: Schema.optional(Schema.Unknown) })
  ),
})

/** Interpret historical tool wire formats once, at their owning boundary.
 * Success here proves recorded execution only, never semantic correctness. */
export function receiptFact(
  operation: ToolOperation | undefined
): ReceiptFact | undefined {
  if (!operation) return undefined
  const { id, turnId, revision, tool, status } = operation
  const fact = { id, turnId, revision, tool, status }
  if (
    status !== "done" ||
    !operation.result ||
    ["update_plan", "read_plan"].includes(tool)
  )
    return { ...fact, outcome: "unavailable" }
  const result = Schema.decodeUnknownSync(Result)(JSON.parse(operation.result))
  let failed = !!result.isError
  if (["run_code", "run_command"].includes(tool)) {
    const text = (result.output ?? result.content)?.find(
      (block) => block.type === "text"
    )?.text
    const outcome = text
      ? Schema.decodeUnknownSync(ExecutionOutcome)(JSON.parse(text))
      : undefined
    failed ||=
      !outcome ||
      outcome.status !== "succeeded" ||
      !!outcome.error ||
      !!outcome.output?.error ||
      (tool === "run_command" && outcome.exitCode !== 0)
  }
  return { ...fact, outcome: failed ? "failed" : "succeeded" }
}
