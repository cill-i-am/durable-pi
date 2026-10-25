import { Result, Schema } from "effect"

import {
  ExecutionFailure,
  type CodeRun,
  type CodeOutput,
  type RunInput,
} from "./contracts"
import {
  newExecutionRecord,
  restoreExecutionRecord,
  type ExecutionRecord,
} from "./run.machine"

/** Identity validation is pure; the machine owns admission and progression. */
export function admitExecution(
  input: RunInput,
  previous: CodeRun | undefined,
  counts: { total: number; running: number },
  writable: boolean,
  busy: boolean,
  now: number,
  attemptId = `legacy:${input.id}`
): Result.Result<{ run: ExecutionRecord; fresh: boolean }, ExecutionFailure> {
  if (previous)
    return previous.input.code !== input.code ||
      previous.input.data !== input.data
      ? Result.fail(
          new ExecutionFailure({
            message: "That run ID already belongs to different code or input.",
          })
        )
      : Result.succeed({ run: restoreExecutionRecord(previous), fresh: false })
  try {
    return Result.succeed({
      fresh: true,
      run: newExecutionRecord(
        input,
        writable,
        busy || counts.running > 0,
        counts.total,
        now,
        attemptId
      ),
    })
  } catch (error) {
    if (Schema.is(ExecutionFailure)(error)) return Result.fail(error)
    throw error
  }
}
export const unavailableOutput = (): CodeOutput => ({
  result: "",
  logs: "",
  error:
    "Execution could not finish. It may have exceeded its time, memory or output limit. Inspect the code before starting a new run.",
})
