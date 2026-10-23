import type { Effect } from "effect"
import { Schema } from "effect"

import type { BrowserRecord, BrowserFailure } from "./contracts"
import type { BrowserEvent } from "./session.machine"

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
  // Event decision and persistence join the same actor transaction.
  advance: (
    event: BrowserEvent
  ) => Effect.Effect<BrowserRecord, BrowserStorageError | BrowserFailure>
}
