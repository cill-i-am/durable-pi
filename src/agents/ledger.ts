import type { Effect } from "effect"

import type { AgentId, AgentProfile, AgentStorageError } from "./domain"
import type { AgentRecord } from "./profile.machine"

/** Catalog publication and replay checks share one actor database transaction. */
export interface AgentCatalogLedger {
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | AgentStorageError, TRequirements>
  list: () => Effect.Effect<AgentRecord[], AgentStorageError>
  read: (
    id: AgentId
  ) => Effect.Effect<AgentRecord | undefined, AgentStorageError>
  activeCount: () => Effect.Effect<number, AgentStorageError>
  ensureHome: (profile: AgentProfile) => Effect.Effect<void, AgentStorageError>
  insert: (profile: AgentRecord) => Effect.Effect<void, AgentStorageError>
  update: (profile: AgentRecord) => Effect.Effect<void, AgentStorageError>
}
