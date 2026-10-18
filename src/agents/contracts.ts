import { Schema } from "effect"

import { RuntimeStatus } from "../conversations/status"
import { AgentId, AgentInstructions, AgentName, AgentProfile } from "./domain"

export const CreateAgent = Schema.Struct({
  id: AgentId,
  name: AgentName,
  instructions: AgentInstructions,
})
export const UpdateAgent = Schema.Struct({
  id: AgentId,
  name: AgentName,
  instructions: AgentInstructions,
})
export const ArchiveAgent = Schema.Struct({
  id: AgentId,
  archived: Schema.Boolean,
})
export const AgentList = Schema.Struct({ agents: Schema.Array(AgentProfile) })
export const AgentStatuses = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({ agentId: AgentId, ...RuntimeStatus.fields })
  ),
})
export { AgentProfile, AgentId, homeAgentId } from "./domain"
export { AgentSlug } from "./slugs"
