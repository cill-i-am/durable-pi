import { Effect, Schema } from "effect"
import type { SkillStore } from "./adapters/sqlite"
import { ArchiveSkill, SaveSkill, SkillId, SkillConflict } from "./contracts"
import { boundedBytes } from "../workspace/http"

export const readSkillJson = (request: Request) =>
  Effect.tryPromise({
    try: async () =>
      JSON.parse(
        new TextDecoder().decode(await boundedBytes(request, 140_000))
      ) as unknown,
    catch: () =>
      new SkillConflict({ message: "Could not read this skill request." }),
  })
export function skillResponse<T>(work: Effect.Effect<T, unknown>) {
  return work.pipe(
    Effect.map((value) => Response.json(value)),
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof SkillConflict
                ? cause.message
                : "The skill request could not be completed. Reload and try again.",
          },
          { status: 409 }
        )
      )
    )
  )
}
export function skillsRequest(
  store: SkillStore,
  request: Request,
  path: string
) {
  return skillResponse(
    Effect.gen(function* () {
      if (request.method === "GET" && path === "skills")
        return yield* Effect.try(() => ({ skills: store.list() }))
      if (request.method === "GET" && path.startsWith("skills/")) {
        const id = yield* Effect.try(() =>
          Schema.decodeUnknownSync(SkillId)(path.slice(7))
        )
        return yield* Effect.try(() => ({ versions: store.versions(id) }))
      }
      const input = yield* readSkillJson(request)
      return yield* Effect.try(() => {
        if (request.method === "POST" && path === "skills/save")
          return store.save(Schema.decodeUnknownSync(SaveSkill)(input))
        if (request.method === "POST" && path === "skills/archive") {
          const body = Schema.decodeUnknownSync(ArchiveSkill)(input)
          return store.archive(
            body.id,
            body.expectedStateRevision,
            body.archived
          )
        }
        throw new SkillConflict({ message: "Unknown skill request." })
      }).pipe(Effect.catch((cause) => Effect.fail(cause.cause)))
    })
  )
}
