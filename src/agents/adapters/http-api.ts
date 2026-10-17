import { Cause, Context, Effect, Layer, Schema } from "effect"
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http"
import { HttpApiBuilder } from "effect/http-api"

import { orDieAll, preserveFatal } from "../../shared/effect"
import { AgentCatalogReadRejected, AgentQueryApi } from "../api"
import { AgentCatalog } from "../catalog"

const rejected = Schema.decodeUnknownSync(AgentCatalogReadRejected)({
  error: "The request could not be completed. Your saved messages are safe.",
})
export const agentQueryHandlers = HttpApiBuilder.group(
  AgentQueryApi,
  "agents",
  (handlers) =>
    Effect.gen(function* () {
      const catalog = yield* AgentCatalog
      return handlers.handle("list", () =>
        catalog.list().pipe(
          Effect.map((agents) => ({ agents })),
          Effect.catchCause((cause) =>
            Effect.failCause(Cause.map(cause, () => rejected))
          ),
          // The installed HttpApi encoder uses typed recovery. Guard a compound
          // failure before that recovery so it cannot turn a defect into HTTP 400.
          preserveFatal
        )
      )
    })
)
export const agentQueryRoutes = HttpApiBuilder.layer(AgentQueryApi).pipe(
  Layer.provide(agentQueryHandlers),
  Layer.provide(HttpServer.layerServices)
)
export class AgentCatalogHttp extends Context.Service<
  AgentCatalogHttp,
  {
    request: (request: Request) => Effect.Effect<Response>
  }
>()("durable-pi/agents/Http") {}

/** Build the router once in its actor scope, then interpret requests through
 * the retained host runtime. Finite JSON responses transfer no scoped stream. */
export const agentCatalogHttp = Layer.effect(
  AgentCatalogHttp,
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(agentQueryRoutes)
    return {
      request: (request: Request) =>
        Effect.scoped(
          handler.pipe(
            Effect.provideService(
              HttpServerRequest.HttpServerRequest,
              HttpServerRequest.fromWeb(request)
            ),
            Effect.map(HttpServerResponse.toWeb),
            orDieAll
          )
        ),
    }
  })
)
