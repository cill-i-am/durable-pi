import { Effect, Schema } from "effect"

import { RuntimeStatus } from "../../conversations/status"
import { nativeObservation } from "../../shared/observation"
import { AgentRuntimeUnavailable, type AgentProfile } from "../domain"

/** Only detached DTOs cross this display observation; the Worker owns late work. */
export function agentRuntimeReader(
  read: (profile: AgentProfile) => Promise<unknown>,
  own: (work: Promise<void>) => void
) {
  return Effect.fn("Agents.readNativeRuntimeStatus")((profile: AgentProfile) =>
    nativeObservation(
      () => read(profile).then(Schema.decodeUnknownSync(RuntimeStatus)),
      own,
      (cause, channel) => {
        const known = Schema.decodeUnknownOption(AgentRuntimeUnavailable)(cause)
        if (known._tag === "Some") return known.value
        if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
        return new AgentRuntimeUnavailable()
      }
    )
  )
}
