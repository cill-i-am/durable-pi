import { Result } from "effect"
import {
  ExecutionFailure,
  type CodeRun,
  type CodeOutput,
  type RunInput,
} from "./contracts"

export function admitExecution(
  input: RunInput,
  previous: CodeRun | undefined,
  counts: { total: number; running: number },
  writable: boolean,
  busy: boolean,
  now: number
): Result.Result<{ run: CodeRun; fresh: boolean }, ExecutionFailure> {
  if (previous) {
    return previous.input.code !== input.code ||
      previous.input.data !== input.data
      ? Result.fail(
          new ExecutionFailure({
            message: "That run ID already belongs to different code or input.",
          })
        )
      : Result.succeed({ run: previous, fresh: false })
  }
  if (!writable)
    return Result.fail(
      new ExecutionFailure({ message: "Restore this bot before running code." })
    )
  if (busy || counts.running > 0)
    return Result.fail(
      new ExecutionFailure({
        message: "Wait for the current run or cancel it first.",
      })
    )
  if (counts.total >= 500)
    return Result.fail(
      new ExecutionFailure({
        message: "This bot has reached its 500-run history limit.",
      })
    )
  return Result.succeed({
    fresh: true,
    run: {
      id: input.id,
      label: (input.code.split("\n")[0] ?? "").slice(0, 100),
      input: { code: input.code, data: input.data },
      status: "running",
      createdAt: now,
      finishedAt: null,
      output: null,
    },
  })
}

export function finishExecution(
  run: CodeRun,
  status: Exclude<CodeRun["status"], "running">,
  output: CodeOutput | null,
  now: number
): CodeRun {
  return run.status === "running"
    ? { ...run, status, output, finishedAt: now }
    : run
}

export const unavailableOutput = (): CodeOutput => ({
  result: "",
  logs: "",
  error:
    "Execution could not finish. It may have exceeded its time, memory or output limit. Inspect the code before starting a new run.",
})
