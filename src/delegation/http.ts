import { Effect, Schema } from "effect"
import { Control, DelegationFailure, NativeId } from "./contracts"
import type { Delegations } from "./delegations"

/** The existing gateway authenticates ownership and checks write origin first. */
export function delegationsRequest(
  service: Pick<Delegations, "list" | "read" | "control" | "transcript">,
  request: Request,
  path: string,
  prefix = "delegations"
) {
  const invalid = () =>
    new DelegationFailure({
      code: "invalid",
      message: "Invalid delegated task request.",
    })
  return Effect.gen(function* () {
    const url = new URL(request.url)
    if (path === prefix && request.method === "GET") {
      const offset = Number(url.searchParams.get("offset") ?? 0)
      if (!Number.isSafeInteger(offset) || offset < 0)
        return new Response("Invalid offset", { status: 400 })
      const groups = yield* service.list(offset)
      return Response.json({
        groups,
        nextOffset: groups.length === 20 ? offset + 20 : null,
      })
    }
    if (path === `${prefix}/control` && request.method === "POST") {
      const text = yield* Effect.tryPromise({
        try: () => request.text(),
        catch: invalid,
      })
      const input = yield* Effect.try({
        try: () => {
          if (text.length > 40000) throw invalid()
          return Schema.decodeUnknownSync(Control)(JSON.parse(text))
        },
        catch: invalid,
      })
      return Response.json(yield* service.control(input))
    }
    if (request.method !== "GET")
      return new Response("Method not allowed", { status: 405 })
    const parts = path.split("/")
    if (parts.length !== 2 && parts.length !== 3)
      return new Response("Not found", { status: 404 })
    const id = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(NativeId)(Number(parts[1])),
      catch: invalid,
    })
    if (parts.length === 2) return Response.json(yield* service.read(id))
    const child = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(NativeId)(Number(parts[2])),
      catch: invalid,
    })
    const cursor = url.searchParams.get("cursor") ?? undefined
    if (cursor && cursor.length > 1000)
      return new Response("Invalid cursor", { status: 400 })
    return Response.json(yield* service.transcript(id, child, cursor))
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        Response.json(
          { error: error.message, code: error.code },
          {
            status:
              error.code === "not_found"
                ? 404
                : error.code === "unavailable"
                  ? 503
                  : error.code === "conflict"
                    ? 409
                    : 400,
          }
        )
      )
    )
  )
}
