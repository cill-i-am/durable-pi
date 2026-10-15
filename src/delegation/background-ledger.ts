import { Schema } from "effect"
import type { Handoff } from "./background-domain"

export class BackgroundStorageError extends Schema.TaggedError<BackgroundStorageError>()(
  "BackgroundStorageError",
  { operation: Schema.String, cause: Schema.Unknown }
) {}

/** Callbacks finish synchronously in the same native transaction. No Effect
 * runner, Promise or external I/O belongs inside atomic. */
export interface BackgroundLedger {
  readonly transactionGroup: object
  readonly atomic: <T>(body: () => T) => T
  readonly get: (id: number) => Handoff | undefined
  readonly list: (offset: number) => Handoff[]
  readonly unfinished: () => Handoff[]
  readonly hasTurn: (turnId: string) => boolean
  readonly put: (row: Handoff) => void
  readonly retry: (operationId: string) => number | undefined
  readonly putRetry: (operationId: string, groupId: number) => void
}
