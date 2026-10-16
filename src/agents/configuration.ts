import { Context, Effect, Layer, Schema } from "effect"
import { AgentConflict } from "./domain"
import type { AgentStorageError, AgentProfile } from "./domain"

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
  read: () => Effect.Effect<AgentConfiguration | undefined, AgentStorageError>
  configure: (
    owner: string,
    profile: AgentProfile
  ) => Effect.Effect<void, AgentConflict | AgentStorageError>
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
export const configurationApplication = (ledger: ConfigurationLedger) =>
  Layer.succeed(BotConfiguration, {
    read: Effect.fn("Agents.readConfiguration")(() => ledger.read()),
    configure: Effect.fn("Agents.configure")(
      (owner: string, profile: AgentProfile) => ledger.configure(owner, profile)
    ),
  })
