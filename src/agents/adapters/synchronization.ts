import { Cache, Context, Data, Effect, Exit, Layer, Schema } from "effect"

import { nativeOperation, nativeResponse } from "../../shared/interop"
import type { TerminalAuthorityProjection } from "../application"
import {
  AgentConflict,
  AgentProfile,
  AgentSynchronizationError,
} from "../domain"

const ConfigurationInput = Schema.Struct({
  owner: Schema.String,
  profile: AgentProfile,
})
export function configurationInput(owner: unknown, profile: unknown) {
  try {
    return Schema.decodeUnknownSync(ConfigurationInput)({ owner, profile })
  } catch (cause) {
    if (Schema.isSchemaError(cause))
      throw new AgentConflict({ message: "Invalid bot profile." })
    throw cause
  }
}

/** Native acknowledgments may ignore abort. Keep the caller's services alive
 * until they settle, and preserve explicit codec/synchronous defects. */
export const agentNativeOperation = <T>(
  operation: string,
  start: (signal: AbortSignal) => Promise<T>
) =>
  nativeOperation(start, (cause, channel) => {
    const known = Schema.decodeUnknownOption(AgentSynchronizationError)(cause)
    if (known._tag === "Some") return known.value
    if (
      channel === "failure" ||
      Schema.isSchemaError(cause) ||
      cause instanceof SyntaxError
    )
      throw cause
    return new AgentSynchronizationError({ operation })
  })
export const synchronizeTerminalAuthority = (
  binding: { fetch: (request: Request) => Promise<Response> },
  actor: string,
  projection: TerminalAuthorityProjection
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const response = yield* nativeResponse(
        (signal) =>
          binding.fetch(
            new Request(`https://terminal.internal/${actor}/authority`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(projection),
              signal,
            })
          ),
        (cause, channel) => {
          if (channel === "failure" || Schema.isSchemaError(cause)) throw cause
          return new AgentSynchronizationError({
            operation: "synchronize terminal authority",
          })
        }
      )
      if (!response.ok)
        return yield* new AgentSynchronizationError({
          operation: "synchronize terminal authority",
        })
    })
  ).pipe(Effect.withSpan("Agents.synchronizeTerminalAuthority"))

class ProjectionKey extends Data.Class<TerminalAuthorityProjection> {}

/** One actor's successful terminal acknowledgments, never user admission.
 * The revision and sticky revocation fence are both part of the key. */
export class TerminalAuthoritySync extends Context.Service<
  TerminalAuthoritySync,
  {
    sync: (
      projection: TerminalAuthorityProjection
    ) => Effect.Effect<void, AgentSynchronizationError>
  }
>()("durable-pi/agents/TerminalAuthoritySync") {}

export const terminalAuthoritySyncLayer = (
  binding: Parameters<typeof synchronizeTerminalAuthority>[0],
  actor: string
) =>
  Layer.effect(
    TerminalAuthoritySync,
    Effect.gen(function* () {
      const acknowledgments = yield* Cache.makeWith(
        (projection: ProjectionKey) =>
          synchronizeTerminalAuthority(binding, actor, projection),
        {
          capacity: 1,
          requireServicesAt: "lookup",
          timeToLive: (exit) => (Exit.isSuccess(exit) ? "60 seconds" : 0),
        }
      )
      return {
        sync: Effect.fn("Agents.ensureTerminalAuthority")(
          (projection: TerminalAuthorityProjection) =>
            Cache.get(
              acknowledgments,
              new ProjectionKey({
                revision: projection.revision,
                active: projection.active,
                revokeThrough: projection.revokeThrough,
              })
            )
        ),
      }
    })
  )
