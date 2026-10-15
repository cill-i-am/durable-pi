import { Effect, Schema } from "effect"
import type { BackgroundDelegation } from "../background-service"
import { NativeId, DelegationFailure } from "../contracts"
import { nativeBytes } from "../../shared/stream"
import { preserveFatal } from "../../shared/effect"
import { delegationsRequest } from "./http"

const Change = Schema.Struct({
  groupId: NativeId,
  operationId: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/i)),
})
export function backgroundRequest(
  service: BackgroundDelegation["Service"],
  request: Request,
  path: string
) {
  if (path !== "background/stop" && path !== "background/retry")
    return delegationsRequest(service, request, path, "background")
  const invalid = () =>
    new DelegationFailure({
      code: "invalid",
      message: "Invalid background task request.",
    })
  return Effect.gen(function* () {
    if (request.method !== "POST")
      return new Response("Method not allowed", { status: 405 })
    if (!request.body) return yield* invalid()
    const bytes = yield* nativeBytes(request.body, 40000, invalid, invalid)
    const input = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Change)
    )(new TextDecoder().decode(bytes)).pipe(
      preserveFatal,
      Effect.mapError(invalid)
    )
    return Response.json(
      yield* path === "background/stop"
        ? service.stop(input.groupId)
        : service.retry(input.groupId, input.operationId)
    )
  }).pipe(
    Effect.scoped,
    preserveFatal,
    Effect.catchTags({
      DelegationFailure: (error) =>
        Effect.succeed(
          Response.json(
            { error: error.message, code: error.code },
            {
              status:
                error.code === "not_found"
                  ? 404
                  : error.code === "conflict"
                    ? 409
                    : error.code === "unavailable"
                      ? 503
                      : 400,
            }
          )
        ),
      BackgroundStorageError: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "Background task state could not be confirmed. Retry the same operation.",
              code: "unavailable",
            },
            { status: 503 }
          )
        ),
      ConversationConflict: (error) =>
        Effect.succeed(
          Response.json({ error: error.message }, { status: 409 })
        ),
      ConversationFull: () =>
        Effect.succeed(
          Response.json(
            { error: "Finish or stop the current reply first." },
            { status: 409 }
          )
        ),
      ConversationStorageError: () =>
        Effect.succeed(
          Response.json(
            {
              error:
                "Background task state could not be confirmed. Retry the same operation.",
              code: "unavailable",
            },
            { status: 503 }
          )
        ),
    })
  )
}
