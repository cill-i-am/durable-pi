import { Schema } from "effect"
import type {
  ActivityAgent,
  ActivityConversation,
  ActivityEntry,
  ActivityQuery,
} from "./contracts"
import type { RunCursor, RunRecords } from "./run"

export class ActivityStorageError extends Schema.TaggedError<ActivityStorageError>()(
  "ActivityStorageError",
  { cause: Schema.Unknown }
) {}
export class ActivityUnavailable extends Schema.TaggedError<ActivityUnavailable>()(
  "ActivityUnavailable",
  { cause: Schema.Unknown }
) {}
export type ActivityError = ActivityStorageError | ActivityUnavailable
export type ConversationRecord = Omit<ActivityConversation, "run"> & {
  rootId: string
}
/** A read model over recorded state. It cannot admit, retry, stop or repair work. */
export interface ActivityRecords {
  readonly entries: (
    agent: ActivityAgent,
    query: ActivityQuery,
    now: number
  ) => ActivityEntry[]
  readonly conversation: (id: string) => ConversationRecord | null
  readonly run: (id: string, cursor: RunCursor | null) => RunRecords | null
}
