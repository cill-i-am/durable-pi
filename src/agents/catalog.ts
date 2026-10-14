import { Context, type Effect } from "effect"
import type { AgentError, AgentId, AgentProfile } from "./domain"

export type AgentDetails = Pick<AgentProfile, "id" | "name" | "instructions">
export class AgentCatalog extends Context.Service<
  AgentCatalog,
  {
    list: () => Effect.Effect<AgentProfile[], AgentError>
    requireActive: (id: AgentId) => Effect.Effect<AgentProfile, AgentError>
    create: (input: AgentDetails) => Effect.Effect<AgentProfile, AgentError>
    update: (input: AgentDetails) => Effect.Effect<AgentProfile, AgentError>
    archive: (
      id: AgentId,
      archived: boolean
    ) => Effect.Effect<AgentProfile, AgentError>
  }
>()("durable-pi/agents/Catalog") {}
