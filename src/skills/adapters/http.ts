import { Effect, Schema } from "effect"

import type {
  ConnectionError,
  ConnectionStorageError,
  ConnectionTransportError,
} from "../../access/connections"
import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import { ArchiveSkill, SaveSkill, SkillId, SkillConflict } from "../contracts"
import type { SkillError } from "../repository"
import type { Skills } from "../service"

export const readSkillJson = (request: Request) =>
  jsonRequest(
    request,
    Schema.Unknown,
    140_000,
    () => new SkillConflict({ message: "Could not read this skill request." })
  )
export function skillResponse<T>(
  work: Effect.Effect<
    T,
    | SkillError
    | Schema.SchemaError
    | ConnectionError
    | ConnectionStorageError
    | ConnectionTransportError
  >
) {
  return work.pipe(
    Effect.map((value) => Response.json(value)),
    preserveFatal,
    Effect.catchTags({
      SkillConflict: (error) => rejected(error.message),
      SkillStorageError: () => rejected(incomplete),
      SchemaError: () => rejected(incomplete),
      ConnectionError: () => rejected(incomplete),
      ConnectionStorageError: () => rejected(incomplete),
      ConnectionTransportError: () => rejected(incomplete),
    })
  )
}
const incomplete =
  "The skill request could not be completed. Reload and try again."
const rejected = (error: string) =>
  Effect.succeed(Response.json({ error }, { status: 409 }))

export function skillsRequest(
  store: Skills["Service"],
  request: Request,
  path: string
) {
  return skillResponse(
    Effect.gen(function* () {
      if (request.method === "GET" && path === "skills")
        return { skills: yield* store.list() }
      if (request.method === "GET" && path.startsWith("skills/")) {
        const id = yield* Schema.decodeUnknownEffect(SkillId)(path.slice(7))
        return { versions: yield* store.versions(id) }
      }
      const input = yield* readSkillJson(request)
      if (request.method === "POST" && path === "skills/save")
        return yield* store.save(
          yield* Schema.decodeUnknownEffect(SaveSkill)(input)
        )
      if (request.method === "POST" && path === "skills/archive") {
        const body = yield* Schema.decodeUnknownEffect(ArchiveSkill)(input)
        return yield* store.archive(
          body.id,
          body.expectedStateRevision,
          body.archived
        )
      }
      return yield* new SkillConflict({ message: "Unknown skill request." })
    })
  )
}
