import { Schema } from "effect"
import type { BrowserRecord, BrowserController } from "./contracts"

export class BrowserStorageError extends Schema.TaggedError<BrowserStorageError>()(
  "BrowserStorageError",
  {}
) {}
export interface BrowserRepository {
  atomic: <T>(body: () => T) => T
  read: () => BrowserRecord
  retire: (id: string) => void
  retired: () => string[]
  forget: (id: string) => void
  // Native generation/write pairs remain synchronous inside the shared transaction.
  update: (
    generation: number,
    patch: Partial<
      Pick<BrowserRecord, "status" | "session" | "capture" | "error">
    >
  ) => BrowserRecord
  reset: (
    generation: number,
    hosts: readonly string[],
    unrestricted?: boolean
  ) => BrowserRecord
  transfer: (generation: number, controller: BrowserController) => BrowserRecord
}
