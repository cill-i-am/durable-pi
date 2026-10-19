import { Effect, Schema } from "effect"

import type { MessageProvenance } from "../../messages/identity"
import { preserveFatal } from "../../shared/effect"
import { nativeBytes } from "../../shared/stream"
import type { BackgroundError } from "../background-mailbox"
import { Control, DelegationFailure, NativeId } from "../contracts"
import type { DelegationQueries } from "../delegations"

export function delegationsRequest(
  service: DelegationQueries<BackgroundError>,
  request: Request,
  path: string,
  prefix = "delegations",
  provenance?: (input: Control) => MessageProvenance | undefined
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
      if (!request.body) return yield* invalid()
      const bytes = yield* nativeBytes(request.body, 40000, invalid, invalid)
      const input = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            groupId: Control.fields.groupId,
            childId: Control.fields.childId,
            operationId: Control.fields.operationId,
            action: Control.fields.action,
          })
        )
      )(new TextDecoder().decode(bytes)).pipe(
        preserveFatal,
        Effect.mapError(invalid)
      )
      const author = provenance?.(input)
      return Response.json(
        yield* service.control({
          ...input,
          ...(author ? { provenance: author } : {}),
        })
      )
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
    Effect.scoped,
    preserveFatal,
    Effect.catchTag("DelegationFailure", (error) =>
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
    ),
    Effect.catchTag("BackgroundStorageError", () =>
      Effect.succeed(
        Response.json(
          {
            error:
              "Background task state could not be confirmed. Retry the same operation.",
            code: "unavailable",
          },
          { status: 503 }
        )
      )
    )
  )
}
