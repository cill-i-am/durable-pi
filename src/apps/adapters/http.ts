import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import {
  AppConflict,
  AppId,
  SaveApp,
  PublishApp,
  ArchiveApp,
  InteractApp,
  RenderWebApp,
} from "../contracts"
import type { Apps, AppError } from "../service"
import type { WebApps } from "../web"

export function appsRequest<TRequirements>(
  store: Apps["Service"],
  request: Request,
  path: string,
  wake: () => Effect.Effect<void, AppError, TRequirements>,
  web?: WebApps
) {
  return Effect.gen(function* () {
    if (path === "apps" && request.method === "GET")
      return Response.json({ apps: yield* store.list() })
    const parts = path.split("/")
    if (request.method === "GET" && parts.length === 2) {
      const id = yield* Schema.decodeUnknownEffect(AppId)(parts[1])
      return Response.json(yield* store.detail(id))
    }
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* jsonRequest(
      request,
      Schema.Unknown,
      120000,
      () => new AppConflict({ message: "Invalid app request." })
    )
    if (path === "apps/render" && web) {
      const input = yield* Schema.decodeUnknownEffect(RenderWebApp)(raw)
      return Response.json(yield* web.render(input, request.signal))
    }
    if (path === "apps/interact") yield* wake()
    const interaction =
      path === "apps/interact"
        ? yield* Schema.decodeUnknownEffect(InteractApp)(raw)
        : null
    const result =
      interaction?.action.type === "web" && web
        ? yield* web.interact(interaction, request.signal)
        : yield* Effect.gen(function* () {
            switch (path) {
              case "apps/cancel":
                return yield* store.cancelOperation(
                  (yield* Schema.decodeUnknownEffect(
                    Schema.Struct({ operationId: AppId })
                  )(raw)).operationId
                )
              case "apps/save":
                return yield* store.save(
                  yield* Schema.decodeUnknownEffect(SaveApp)(raw)
                )
              case "apps/publish":
                return yield* store.publish(
                  yield* Schema.decodeUnknownEffect(PublishApp)(raw)
                )
              case "apps/archive":
                return yield* store.archive(
                  yield* Schema.decodeUnknownEffect(ArchiveApp)(raw)
                )
              case "apps/interact":
                return yield* store.interact(
                  yield* Schema.decodeUnknownEffect(InteractApp)(raw)
                )
              default:
                return yield* new AppConflict({
                  message: "Unknown app action.",
                })
            }
          })
    if (path === "apps/interact") yield* wake()
    return Response.json(result)
  }).pipe(
    preserveFatal,
    Effect.catchTags({
      AppConflict: (error) => rejected(error.message),
      AppStorageError: () => rejected(incomplete),
      SchemaError: () => rejected(incomplete),
    })
  )
}
const incomplete =
  "The app request is invalid or could not finish. Reload and retry the same change."
const rejected = (error: string) =>
  Effect.succeed(Response.json({ error }, { status: 409 }))
