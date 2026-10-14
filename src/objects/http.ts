import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import {
  ObjectFailure,
  ObjectId,
  ObjectMutation,
  Revision,
  type OriginConversation,
} from "./contracts"
import type { WorkingObjects } from "./objects"

const invalid = () =>
  new ObjectFailure({
    code: "invalid",
    message: "Check the checklist fields and try again.",
  })
const decode = <T>(body: () => T) => Effect.try({ try: body, catch: invalid })

export function objectsRequest(
  objects: WorkingObjects,
  request: Request,
  path: string,
  conversation: (id: string) => OriginConversation | undefined
) {
  return Effect.gen(function* () {
    if (path === "objects" && request.method === "GET")
      return Response.json({ objects: yield* objects.list() })
    const parts = path.split("/")
    if (request.method === "GET" && parts.length >= 2 && parts.length <= 3) {
      const id = yield* decode(() =>
        Schema.decodeUnknownSync(ObjectId)(parts[1])
      )
      const cursor = new URL(request.url).searchParams.get("before")
      const before =
        cursor === null
          ? undefined
          : yield* decode(() =>
              Schema.decodeUnknownSync(Revision)(Number(cursor))
            )
      const detail = yield* objects.read(id, before)
      if (parts.length === 2) return Response.json(detail)
      if (parts[2] === "origin") {
        const origin = detail.object.origin.turnId
          ? conversation(detail.object.origin.turnId)
          : undefined
        return origin
          ? Response.json(origin)
          : Response.json(
              { error: "This checklist was created in the workbench." },
              { status: 404 }
            )
      }
    }
    if (
      request.method !== "POST" ||
      !["objects/mutate", "objects/cancel"].includes(path)
    )
      return new Response("Not found", { status: 404 })
    const raw = yield* Effect.tryPromise({
      try: async () =>
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 800000))
        ) as unknown,
      catch: invalid,
    })
    if (path === "objects/cancel") {
      const input = yield* decode(() =>
        Schema.decodeUnknownSync(Schema.Struct({ operationId: ObjectId }))(raw)
      )
      return Response.json(yield* objects.cancel(input.operationId))
    }
    const input = yield* decode(() =>
      Schema.decodeUnknownSync(ObjectMutation)(raw)
    )
    yield* decode(() => Schema.decodeUnknownSync(ObjectId)(input.operationId))
    return Response.json(
      yield* objects.mutate(input, {
        actor: "user",
        surface: input.surface ?? "workbench",
        turnId: null,
        toolCallId: null,
      })
    )
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Response.json(
          { error: error.message, code: error.code },
          {
            status:
              error.code === "not_found"
                ? 404
                : error.code === "invalid"
                  ? 400
                  : error.code === "unavailable"
                    ? 503
                    : 409,
          }
        )
      )
    )
  )
}
