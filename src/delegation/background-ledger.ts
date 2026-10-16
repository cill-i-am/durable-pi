import type { Effect } from "effect"
import { Schema } from "effect"
import type { Handoff } from "./background-domain"

export class BackgroundStorageError extends Schema.TaggedError<BackgroundStorageError>()(
  "BackgroundStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

/** Effects compose in the same database coordinator and transaction. */
export interface BackgroundLedger {
  readonly transactionGroup: object
  readonly atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | BackgroundStorageError, TRequirements>
  readonly get: (
    id: number
  ) => Effect.Effect<Handoff | undefined, BackgroundStorageError>
  readonly list: (
    offset: number
  ) => Effect.Effect<Handoff[], BackgroundStorageError>
  readonly unfinished: () => Effect.Effect<Handoff[], BackgroundStorageError>
  readonly hasTurn: (
    turnId: string
  ) => Effect.Effect<boolean, BackgroundStorageError>
  readonly put: (row: Handoff) => Effect.Effect<void, BackgroundStorageError>
  readonly retry: (
    operationId: string
  ) => Effect.Effect<number | undefined, BackgroundStorageError>
  readonly putRetry: (
    operationId: string,
    groupId: number
  ) => Effect.Effect<void, BackgroundStorageError>
}
