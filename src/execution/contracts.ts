import { Schema } from "effect"

export const RunId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200)
)
export const CodeInput = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384)),
  data: Schema.String.check(
    Schema.isMaxLength(32768),
    Schema.makeFilter((value) => {
      try {
        JSON.parse(value)
        return true
      } catch {
        return "Input must be valid JSON."
      }
    })
  ),
})
export const RunInput = Schema.Struct({ id: RunId, ...CodeInput.fields })
export type RunInput = typeof RunInput.Type
export type CodeInput = typeof CodeInput.Type
export const CodeOutput = Schema.Struct({
  result: Schema.String.check(Schema.isMaxLength(32768)),
  logs: Schema.String.check(Schema.isMaxLength(16000)),
  error: Schema.NullOr(Schema.String.check(Schema.isMaxLength(1000))),
})
export type CodeOutput = typeof CodeOutput.Type
export const RunStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
])
export const RunSummary = Schema.Struct({
  id: RunId,
  label: Schema.String,
  status: RunStatus,
  createdAt: Schema.Number,
  finishedAt: Schema.NullOr(Schema.Number),
})
export const CodeRun = Schema.Struct({
  ...RunSummary.fields,
  input: CodeInput,
  output: Schema.NullOr(CodeOutput),
})
export type CodeRun = typeof CodeRun.Type
export type RunSummary = typeof RunSummary.Type
export const RunHistory = Schema.Struct({ runs: Schema.Array(RunSummary) })
export class ExecutionFailure extends Schema.TaggedError<ExecutionFailure>()(
  "ExecutionFailure",
  { message: Schema.String }
) {}
export const EXECUTION_TIMEOUT_MS = 10000
export const EXECUTION_CPU_MS = 1000
