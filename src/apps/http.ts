import { Effect, Schema } from "effect"
import { boundedBytes } from "../workspace/http"
import {
  AppConflict,
  AppId,
  SaveApp,
  PublishApp,
  ArchiveApp,
  InteractApp,
  RenderWebApp,
} from "./contracts"
import type { WebApps } from "./web"
import type { AppStore } from "./adapters/sqlite"

export function appsRequest(
  store: AppStore,
  request: Request,
  path: string,
  wake: () => Promise<void>,
  web?: WebApps
) {
  return Effect.gen(function* () {
    if (path === "apps" && request.method === "GET")
      return Response.json({ apps: store.list() })
    const parts = path.split("/")
    if (request.method === "GET" && parts.length === 2) {
      const id = yield* Effect.try(() =>
        Schema.decodeUnknownSync(AppId)(parts[1])
      )
      return Response.json(yield* Effect.try(() => store.detail(id)))
    }
    if (request.method !== "POST")
      return new Response("Not found", { status: 404 })
    const raw = yield* Effect.tryPromise(
      async () =>
        JSON.parse(
          new TextDecoder().decode(await boundedBytes(request, 120000))
        ) as unknown
    )
    if (path === "apps/render" && web) {
      const input = yield* Effect.try(() =>
        Schema.decodeUnknownSync(RenderWebApp)(raw)
      )
      return Response.json(yield* web.render(input, request.signal))
    }
    if (path === "apps/interact") yield* Effect.tryPromise(wake)
    const interaction =
      path === "apps/interact"
        ? yield* Effect.try(() => Schema.decodeUnknownSync(InteractApp)(raw))
        : null
    const result =
      interaction?.action.type === "web" && web
        ? yield* web.interact(interaction, request.signal)
        : yield* Effect.try(() => {
            switch (path) {
              case "apps/cancel":
                return store.cancelOperation(
                  Schema.decodeUnknownSync(
                    Schema.Struct({ operationId: AppId })
                  )(raw).operationId
                )
              case "apps/save":
                return store.save(Schema.decodeUnknownSync(SaveApp)(raw))
              case "apps/publish":
                return store.publish(Schema.decodeUnknownSync(PublishApp)(raw))
              case "apps/archive":
                return store.archive(Schema.decodeUnknownSync(ArchiveApp)(raw))
              case "apps/interact":
                return store.interact(
                  Schema.decodeUnknownSync(InteractApp)(raw)
                )
              default:
                throw new AppConflict({ message: "Unknown app action." })
            }
          })
    if (path === "apps/interact") yield* Effect.tryPromise(wake)
    return Response.json(result)
  }).pipe(
    Effect.catch((cause) => {
      const error =
        cause instanceof AppConflict
          ? cause
          : typeof cause === "object" &&
              "cause" in cause &&
              cause.cause instanceof AppConflict
            ? cause.cause
            : null
      return Effect.succeed(
        Response.json(
          {
            error:
              error?.message ??
              "The app request is invalid or could not finish. Reload and retry the same change.",
          },
          { status: 409 }
        )
      )
    })
  )
}
