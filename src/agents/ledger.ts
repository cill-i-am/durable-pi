import type { Effect } from "effect"

import type { AgentId, AgentProfile, AgentStorageError } from "./domain"

/** Catalog publication and replay checks share one actor database transaction. */
export interface AgentCatalogLedger {
  readonly transactionGroup: object
  atomic: <TValue, TError, TRequirements>(
    body: () => Effect.Effect<TValue, TError, TRequirements>
  ) => Effect.Effect<TValue, TError | AgentStorageError, TRequirements>
  list: () => Effect.Effect<AgentProfile[], AgentStorageError>
  read: (
    id: AgentId
  ) => Effect.Effect<AgentProfile | undefined, AgentStorageError>
  creation: (
    id: AgentId
  ) => Effect.Effect<string | undefined, AgentStorageError>
  activeCount: () => Effect.Effect<number, AgentStorageError>
  ensureHome: (profile: AgentProfile) => Effect.Effect<void, AgentStorageError>
  insert: (
    profile: AgentProfile,
    creation: string
  ) => Effect.Effect<void, AgentStorageError>
  update: (profile: AgentProfile) => Effect.Effect<void, AgentStorageError>
}
