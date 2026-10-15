import { Context, Schema } from "effect"
import type { Routine, RoutineRun } from "./contracts"

export class RoutineStorageError extends Schema.TaggedError<RoutineStorageError>()(
  "RoutineStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

export type OperationReceipt = { input: string; result: string }

/**
 * Synchronous transaction capability, deliberately narrower than a SQL client.
 * atomic must roll back all writes (including admission writes on the same
 * transactionGroup) when body throws. No Promise, fiber or external I/O may escape
 * body. Receipt retention is permanent; pruning run history never prunes receipts.
 */
export class RoutinePersistence extends Context.Service<
  RoutinePersistence,
  {
    readonly transactionGroup: object
    readonly atomic: <TResult>(body: () => TResult) => TResult
    readonly list: () => Routine[]
    readonly get: (id: string) => Routine | undefined
    readonly runs: () => RoutineRun[]
    readonly inFlight: () => RoutineRun | undefined
    readonly put: (routine: Routine) => Routine
    readonly putRun: (run: RoutineRun) => RoutineRun
    readonly operation: (id: string) => OperationReceipt | undefined
    readonly operationCount: () => number
    readonly putOperation: (id: string, receipt: OperationReceipt) => void
    readonly pruneRuns: () => void
  }
>()("durable-pi/routines/Persistence") {}
