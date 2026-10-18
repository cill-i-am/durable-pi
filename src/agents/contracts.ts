import { Schema, SchemaGetter } from "effect"

import { RuntimeStatus } from "../conversations/status"
import {
  AgentId,
  AgentInstructions,
  AgentName,
  AgentProfile as StoredProfile,
} from "./domain"

// Web responses and RPC can reach an older, still-running actor during a
// rollout. Normalize its ID alias at the boundary; persisted profiles stay strict.
export const AgentProfile = Schema.Struct({
  ...StoredProfile.fields,
  slug: Schema.optional(StoredProfile.fields.slug),
}).pipe(
  Schema.decodeTo(Schema.toType(StoredProfile), {
    decode: SchemaGetter.transform((profile) => ({
      ...profile,
      slug: profile.slug ?? profile.id,
    })),
    encode: SchemaGetter.transform((profile) => profile),
  })
)
export type AgentProfile = typeof StoredProfile.Type

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
export { AgentId, homeAgentId } from "./domain"
export { AgentSlug } from "./slugs"
