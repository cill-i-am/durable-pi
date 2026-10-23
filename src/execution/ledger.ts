import type { Effect } from "effect"

import type { RunSummary, ExecutionStorageError } from "./contracts"
import type { ExecutionRecord } from "./run.machine"

/** Reads and publication join one actor database transaction. */
export interface ExecutionLedger {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | ExecutionStorageError, TRequirements>
  list: () => Effect.Effect<RunSummary[], ExecutionStorageError>
  get: (
    id: string
  ) => Effect.Effect<ExecutionRecord | undefined, ExecutionStorageError>
  counts: () => Effect.Effect<
    { total: number; running: number },
    ExecutionStorageError
  >
  running: () => Effect.Effect<ExecutionRecord[], ExecutionStorageError>
  put: (run: ExecutionRecord) => Effect.Effect<void, ExecutionStorageError>
}
