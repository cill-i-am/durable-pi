import { Schema } from "effect"
import type { Effect } from "effect"

import type { CodeInput, CodeOutput } from "./contracts"

export class ExecutorUnavailable extends Schema.TaggedError<ExecutorUnavailable>()(
  "ExecutorUnavailable",
  {}
) {}

export interface CodeExecutor {
  run: (input: CodeInput) => Effect.Effect<CodeOutput, ExecutorUnavailable>
}
