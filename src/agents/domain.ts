import { Schema } from "effect"

import { AgentSlug } from "./slugs"

export const AgentId = Schema.String.check(
  Schema.isPattern(
    /^(home|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/
  )
).pipe(Schema.brand("AgentId"))
export type AgentId = typeof AgentId.Type
export const homeAgentId = Schema.decodeUnknownSync(AgentId)("home")
export const AgentName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/\S/)
)
export const AgentInstructions = Schema.String.check(Schema.isMaxLength(8000))
export const AgentProfile = Schema.Struct({
  id: AgentId,
  slug: AgentSlug,
  name: AgentName,
  instructions: AgentInstructions,
  status: Schema.Literals(["active", "archived"]),
  revision: Schema.Number.check(
    Schema.isInt(),
    Schema.isGreaterThanOrEqualTo(0)
  ),
  createdAt: Schema.String,
  updatedAt: Schema.String,
})
export type AgentProfile = typeof AgentProfile.Type
export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()(
  "AgentNotFound",
  {}
) {}
export class AgentConflict extends Schema.TaggedError<AgentConflict>()(
  "AgentConflict",
  {
    message: Schema.String,
  }
) {}
export class AgentStorageError extends Schema.TaggedError<AgentStorageError>()(
  "AgentStorageError",
  {}
) {}
export type AgentError = AgentNotFound | AgentConflict | AgentStorageError
export class AgentSynchronizationError extends Schema.TaggedError<AgentSynchronizationError>()(
  "AgentSynchronizationError",
  { operation: Schema.String }
) {}
export class AgentRuntimeUnavailable extends Schema.TaggedError<AgentRuntimeUnavailable>()(
  "AgentRuntimeUnavailable",
  {}
) {}

export function agentObjectName(owner: string, id: AgentId) {
  return id === homeAgentId ? owner : `bot:${owner}:${id}`
}

export const ACTIVE_AGENTS = 32
export function requireAgent(
  profile: AgentProfile | undefined,
  activeOnly = false
) {
  if (!profile || (activeOnly && profile.status !== "active"))
    throw new AgentNotFound()
  return profile
}
export function requireAgentCapacity(active: number) {
  if (active >= ACTIVE_AGENTS)
    throw new AgentConflict({
      message:
        "Archive a bot before creating or restoring another. You can have 32 active bots.",
    })
}
export function agentCreationReplay(
  previous: string | undefined,
  creation: string
) {
  if (previous === undefined) return false
  if (previous !== creation)
    throw new AgentConflict({
      message: "This creation request belongs to another bot.",
    })
  return true
}
export function agentArchiveChange(
  current: AgentProfile,
  archived: boolean,
  active: number
) {
  if (current.id === homeAgentId && archived)
    throw new AgentConflict({
      message: "Your original personal assistant stays available.",
    })
  if (!archived && current.status === "archived") requireAgentCapacity(active)
  return archived ? ("archived" as const) : ("active" as const)
}
export const originalAgent = (now: string): AgentProfile => ({
  id: homeAgentId,
  slug: "personal-assistant",
  name: "Personal assistant",
  instructions: "",
  status: "active",
  revision: 0,
  createdAt: now,
  updatedAt: now,
})
