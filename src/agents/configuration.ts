import { Context, Effect, Layer, Schema } from "effect"
import { AgentConflict, AgentStorageError, type AgentProfile } from "./domain"

export const AgentConfiguration = Schema.Struct({
  owner: Schema.String,
  instructions: Schema.String,
  // Legacy configurations predate the admission row and read as revision -1.
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(-1)),
  status: Schema.Literals(["active", "archived"]),
})
export type AgentConfiguration = typeof AgentConfiguration.Type
export interface ConfigurationLedger {
  readonly transactionGroup: object
  read: () => AgentConfiguration | undefined
  configure: (owner: string, profile: AgentProfile) => void
}
export function configurationChange(
  current: AgentConfiguration | undefined,
  owner: string,
  profile: AgentProfile
) {
  if (current && current.owner !== owner)
    throw new AgentConflict({ message: "Owner mismatch" })
  return !current || current.revision < profile.revision
}
export class BotConfiguration extends Context.Service<
  BotConfiguration,
  {
    read: () => Effect.Effect<
      AgentConfiguration | undefined,
      AgentConflict | AgentStorageError
    >
    configure: (
      owner: string,
      profile: AgentProfile
    ) => Effect.Effect<void, AgentConflict | AgentStorageError>
  }
>()("durable-pi/agents/BotConfiguration") {}
const attempt = <T>(body: () => T) =>
  Effect.try({
    try: body,
    catch: (cause) => {
      const knownFailure = Schema.decodeUnknownOption(
        Schema.Union([AgentConflict, AgentStorageError])
      )(cause)
      if (knownFailure._tag === "Some") return knownFailure.value
      throw cause
    },
  })
export const configurationApplication = (ledger: ConfigurationLedger) =>
  Layer.succeed(BotConfiguration, {
    read: Effect.fn("Agents.readConfiguration")(() =>
      attempt(() => ledger.read())
    ),
    configure: Effect.fn("Agents.configure")(
      (owner: string, profile: AgentProfile) =>
        attempt(() => ledger.configure(owner, profile))
    ),
  })
