import type { AgentId, AgentProfile } from "./domain"

/** One native catalog owns replay identity, capacity and profile publication. */
export interface AgentCatalogLedger {
  readonly transactionGroup: object
  atomic: <T>(body: () => T) => T
  list: () => AgentProfile[]
  read: (id: AgentId) => AgentProfile | undefined
  creation: (id: AgentId) => string | undefined
  activeCount: () => number
  ensureHome: (profile: AgentProfile) => void
  insert: (profile: AgentProfile, creation: string) => void
  update: (profile: AgentProfile) => void
}
