import { Effect, Schema } from "effect"
import type { AgentId } from "../../agents/domain"
import {
  ActivityFilter,
  ActivityCursor,
  type ActivityQuery,
} from "../contracts"
import { RunCursor } from "../run"
import type { ActivityDirectory } from "../reader"
import { activityOverview, activityRecord } from "../reader"
import { preserveFatal } from "../../shared/effect"

class ActivityRequestInvalid extends Schema.TaggedError<ActivityRequestInvalid>()(
  "ActivityRequestInvalid",
  { message: Schema.String }
) {}
export function activityQuery(url: URL): ActivityQuery {
  const filter = Schema.decodeUnknownSync(ActivityFilter)(
    url.searchParams.get("filter") ?? "all"
  )
  const cursor = url.searchParams.get("cursor")
  return {
    filter,
    cursor: cursor
      ? Schema.decodeUnknownSync(Schema.fromJsonString(ActivityCursor))(cursor)
      : null,
  }
}
export function activityRequest(
  directory: ActivityDirectory,
  selectedId: AgentId,
  request: Request,
  path: string
): Effect.Effect<Response> {
  return Effect.gen(function* () {
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 })
    const url = new URL(request.url)
    if (path.startsWith("activity/conversations/")) {
      const id = path.slice("activity/conversations/".length)
      if (!/^[a-f0-9-]{36}$/i.test(id))
        return new Response("Not found", { status: 404 })
      const cursor = yield* Effect.try({
        try: () => {
          const raw = url.searchParams.get("cursor")
          return raw
            ? Schema.decodeUnknownSync(Schema.fromJsonString(RunCursor))(raw)
            : null
        },
        catch: () =>
          new ActivityRequestInvalid({ message: "Invalid run cursor" }),
      })
      const record = yield* activityRecord(directory, selectedId, id, cursor)
      return record
        ? Response.json(record)
        : new Response("Not found", { status: 404 })
    }
    const query = yield* Effect.try({
      try: () => activityQuery(url),
      catch: () =>
        new ActivityRequestInvalid({ message: "Invalid activity query" }),
    })
    const scope = url.searchParams.get("scope") ?? "bot"
    if (scope !== "bot" && scope !== "all")
      return new Response("Invalid activity scope", { status: 400 })
    const page = yield* activityOverview(directory, selectedId, scope, query)
    return page
      ? Response.json(page)
      : new Response("Not found", { status: 404 })
  }).pipe(
    preserveFatal,
    Effect.catchTags({
      ActivityRequestInvalid: (error) =>
        Effect.succeed(new Response(error.message, { status: 400 })),
      ActivityUnavailable: () =>
        Effect.succeed(
          Response.json(
            { error: "Activity is temporarily unavailable. Please retry." },
            { status: 503 }
          )
        ),
    })
  )
}
