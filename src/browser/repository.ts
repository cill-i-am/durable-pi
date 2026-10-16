import type { Effect } from "effect"
import { Schema } from "effect"
import type {
  BrowserRecord,
  BrowserController,
  BrowserFailure,
} from "./contracts"

export class BrowserStorageError extends Schema.TaggedError<BrowserStorageError>()(
  "BrowserStorageError",
  {}
) {}
export interface BrowserRepository {
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | BrowserStorageError, TRequirements>
  read: () => Effect.Effect<BrowserRecord, BrowserStorageError>
  retire: (id: string) => Effect.Effect<void, BrowserStorageError>
  retired: () => Effect.Effect<string[], BrowserStorageError>
  forget: (id: string) => Effect.Effect<void, BrowserStorageError>
  // Generation checks and writes join the same actor transaction.
  update: (
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) => Effect.Effect<BrowserRecord, BrowserStorageError | BrowserFailure>
  reset: (
    generation: number,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => Effect.Effect<BrowserRecord, BrowserStorageError | BrowserFailure>
  transfer: (
    generation: number,
    controller: BrowserController
  ) => Effect.Effect<BrowserRecord, BrowserStorageError | BrowserFailure>
}
