import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import type { AgentCatalog } from "../catalog"
import { CreateAgent, UpdateAgent, ArchiveAgent } from "../contracts"
import {
  AgentConflict,
  type AgentId,
  type AgentProfile,
  type AgentError,
  type AgentSynchronizationError,
} from "../domain"

class AgentRequestInvalid extends Schema.TaggedError<AgentRequestInvalid>()(
  "AgentRequestInvalid",
  {}
) {}
const decode = <T>(
  schema: Schema.ConstraintDecoder<T, never>,
  input: unknown
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError(() => new AgentRequestInvalid())
  )
export function agentCatalogRequest<TRequirements>(
  catalog: AgentCatalog["Service"],
  archive: (
    owner: string,
    id: AgentId,
    archived: boolean
  ) => Effect.Effect<
    AgentProfile,
    AgentError | AgentSynchronizationError,
    TRequirements
  >,
  path: string,
  owner: string,
  input: unknown
) {
  const operation = Effect.gen(function* () {
    if (path === "bots/create")
      return yield* catalog.create(yield* decode(CreateAgent, input))
    if (path === "bots/update")
      return yield* catalog.update(yield* decode(UpdateAgent, input))
    if (path === "bots/archive") {
      const change = yield* decode(ArchiveAgent, input)
      return yield* archive(owner, change.id, change.archived)
    }
    return yield* new AgentConflict({
      message: "This bot could not be updated.",
    })
  })
  return operation.pipe(
    Effect.map((profile) => Response.json(profile)),
    preserveFatal,
    Effect.catchTag("AgentRequestInvalid", () =>
      Effect.succeed(
        Response.json(
          {
            error:
              "The request could not be completed. Your saved messages are safe.",
          },
          { status: 400 }
        )
      )
    ),
    preserveFatal,
    Effect.catchTags({
      AgentConflict: (error) => rejected(error.message),
      AgentNotFound: () => rejected(),
      AgentStorageError: () => rejected(),
      AgentSynchronizationError: () => rejected(),
    })
  )
}
const rejected = (error = "This bot could not be updated.") =>
  Effect.succeed(Response.json({ error }, { status: 409 }))
