import type { Effect } from "effect"

import type {
  CodeRun,
  ExecutionFailure,
  ExecutionStorageError,
  RunInput,
  RunSummary,
} from "./contracts"

export interface ExecutionTask {
  run: CodeRun
  completion: Effect.Effect<CodeRun, ExecutionStorageError>
}
export interface ExecutionOperations {
  list: () => Effect.Effect<RunSummary[], ExecutionStorageError>
  get: (id: string) => Effect.Effect<CodeRun | undefined, ExecutionStorageError>
  start: (
    input: RunInput
  ) => Effect.Effect<ExecutionTask, ExecutionFailure | ExecutionStorageError>
  cancel: (
    id: string
  ) => Effect.Effect<CodeRun, ExecutionFailure | ExecutionStorageError>
  run: (
    input: RunInput
  ) => Effect.Effect<CodeRun, ExecutionFailure | ExecutionStorageError>
  recover: () => Effect.Effect<void, ExecutionFailure | ExecutionStorageError>
}
