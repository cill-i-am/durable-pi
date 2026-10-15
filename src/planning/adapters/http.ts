import { preserveFatal } from "../../shared/effect"
import { Effect, Schema } from "effect"
import { PlanFailure, Revision } from "../contracts"
import type { Plans } from "../plans"

export function plansRequest<TRequirements>(
  plans: Plans<TRequirements>,
  request: Request,
  path: string
): Effect.Effect<Response, never, TRequirements> {
  return Effect.gen(function* () {
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 })
    if (path === "plans") {
      const offset = yield* Schema.decodeUnknownEffect(Revision)(
        Number(new URL(request.url).searchParams.get("offset") ?? 0)
      ).pipe(
        Effect.mapError(
          () =>
            new PlanFailure({
              code: "invalid",
              message: "Invalid page offset.",
            })
        )
      )
      const values = yield* plans.list(offset)
      return Response.json({
        plans: values,
        nextOffset: values.length === 20 ? offset + 20 : null,
      })
    }
    const parts = path.split("/")
    if (parts.length !== 2) return new Response("Not found", { status: 404 })
    const cursor = new URL(request.url).searchParams.get("before")
    return Response.json(
      yield* plans.read(parts[1]!, cursor === null ? undefined : Number(cursor))
    )
  }).pipe(
    preserveFatal,
    Effect.catchTag("PlanFailure", (error) =>
      Effect.succeed(
        Response.json(
          { error: error.message, code: error.code },
          {
            status:
              error.code === "not_found"
                ? 404
                : error.code === "unavailable"
                  ? 503
                  : 400,
          }
        )
      )
    )
  )
}
