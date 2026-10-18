import { Schema, SchemaGetter } from "effect"

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
// During a rolling deploy an older worker can still return an ID-only profile.
// Preserve that working link until the catalog supplies its persisted slug.
export const AgentProfileResponse = Schema.Struct({
  ...AgentProfile.fields,
  slug: Schema.optional(AgentProfile.fields.slug),
}).pipe(
  Schema.decodeTo(Schema.toType(AgentProfile), {
    decode: SchemaGetter.transform((profile) => ({
      ...profile,
      slug: profile.slug ?? profile.id,
    })),
    encode: SchemaGetter.transform((profile) => profile),
  })
)
export const AgentList = Schema.Struct({
  agents: Schema.Array(AgentProfileResponse),
})
export const AgentStatuses = Schema.Struct({
  statuses: Schema.Array(
    Schema.Struct({ agentId: AgentId, ...RuntimeStatus.fields })
  ),
})
export { AgentProfile, AgentId, homeAgentId } from "./domain"
export { AgentSlug } from "./slugs"
