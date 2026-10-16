import type { Effect } from "effect"
import type { CodeRun, RunSummary, ExecutionStorageError } from "./contracts"

/** Reads and publication join one actor database transaction. */
export interface ExecutionLedger {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | ExecutionStorageError, TRequirements>
  list: () => Effect.Effect<RunSummary[], ExecutionStorageError>
  get: (id: string) => Effect.Effect<CodeRun | undefined, ExecutionStorageError>
  counts: () => Effect.Effect<
    { total: number; running: number },
    ExecutionStorageError
  >
  running: () => Effect.Effect<CodeRun[], ExecutionStorageError>
  put: (run: CodeRun) => Effect.Effect<void, ExecutionStorageError>
}
