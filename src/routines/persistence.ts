import { Context, Schema, type Effect } from "effect"

import type { Routine, RoutineRun } from "./contracts"

export class RoutineStorageError extends Schema.TaggedError<RoutineStorageError>()(
  "RoutineStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}
export type OperationReceipt = { input: string; result: string }

/** Receipt retention is permanent; atomic joins admission writes on the same actor. */
export class RoutinePersistence extends Context.Service<
  RoutinePersistence,
  {
    readonly transactionGroup: object
    readonly atomic: <TValue, TError, TRequirements>(
      body: () => Effect.Effect<TValue, TError, TRequirements>
    ) => Effect.Effect<TValue, TError | RoutineStorageError, TRequirements>
    readonly list: () => Effect.Effect<Routine[], RoutineStorageError>
    readonly get: (
      id: string
    ) => Effect.Effect<Routine | undefined, RoutineStorageError>
    readonly runs: () => Effect.Effect<RoutineRun[], RoutineStorageError>
    readonly inFlight: () => Effect.Effect<
      RoutineRun | undefined,
      RoutineStorageError
    >
    readonly put: (
      routine: Routine
    ) => Effect.Effect<Routine, RoutineStorageError>
    readonly putRun: (
      run: RoutineRun
    ) => Effect.Effect<RoutineRun, RoutineStorageError>
    readonly operation: (
      id: string
    ) => Effect.Effect<OperationReceipt | undefined, RoutineStorageError>
    readonly operationCount: () => Effect.Effect<number, RoutineStorageError>
    readonly putOperation: (
      id: string,
      receipt: OperationReceipt
    ) => Effect.Effect<void, RoutineStorageError>
    readonly pruneRuns: () => Effect.Effect<void, RoutineStorageError>
  }
>()("durable-pi/routines/Persistence") {}
