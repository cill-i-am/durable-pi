import { Schema } from "effect"

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

/** The existing owner-named object is the home bot. Never migrate its data. */
export function agentObjectName(owner: string, id: AgentId) {
  return id === homeAgentId ? owner : `bot:${owner}:${id}`
}
