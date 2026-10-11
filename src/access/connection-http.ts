import { Effect, Schema } from "effect"
import {
  ChangeConnection,
  ConnectionError,
  ConnectionId,
  NewConnection,
} from "./connections"
import type { RemoteConnections } from "./adapters/mcp"
import { boundedBytes } from "../workspace/http"

export const connectionJson = (request: Request) =>
  Effect.tryPromise(() =>
    boundedBytes(request, 16_000).then(
      (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown
    )
  )
export function connectionResponse<T>(work: Effect.Effect<T, unknown>) {
  return work.pipe(
    Effect.map((value) => Response.json(value)),
    Effect.catch((cause) =>
      Effect.succeed(
        Response.json(
          {
            error:
              cause instanceof ConnectionError
                ? cause.message
                : "The connection request could not be completed. Reload and try again.",
          },
          { status: 409 }
        )
      )
    )
  )
}
export function connectionRequest(
  connections: RemoteConnections,
  request: Request,
  path: string,
  origin: string
) {
  if (path === "connections/callback") {
    const publicRequest = new Request(
      `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`,
      { method: request.method }
    )
    return connections.callback(publicRequest).pipe(
      Effect.map(
        () =>
          new Response(null, {
            status: 303,
            headers: {
              Location: "/?connections=connected",
              "Referrer-Policy": "no-referrer",
            },
          })
      ),
      Effect.catch(() =>
        Effect.succeed(
          new Response(null, {
            status: 303,
            headers: {
              Location: "/?connections=failed",
              "Referrer-Policy": "no-referrer",
            },
          })
        )
      )
    )
  }
  return connectionResponse(
    Effect.gen(function* () {
      if (request.method === "GET" && path === "connections")
        return {
          connections: yield* Effect.tryPromise(() => connections.list()),
        }
      if (request.method !== "POST")
        return yield* new ConnectionError({
          message: "Use POST to change connections.",
        })
      const input = yield* connectionJson(request)
      if (path === "connections/add") {
        const body = yield* Effect.try(() =>
          Schema.decodeUnknownSync(NewConnection)(input)
        )
        yield* connections.connect(body, origin)
      } else if (
        path === "connections/disconnect" ||
        path === "connections/reconnect"
      ) {
        const body = yield* Effect.try(() =>
          Schema.decodeUnknownSync(ChangeConnection)(input)
        )
        yield* path.endsWith("/disconnect")
          ? connections.disconnect(body.id, body.expectedRevision)
          : connections.reconnect(body.id, body.expectedRevision, origin)
      } else if (path === "connections/refresh") {
        const body = yield* Effect.try(() =>
          Schema.decodeUnknownSync(Schema.Struct({ id: ConnectionId }))(input)
        )
        yield* connections.refresh(body.id)
      } else
        return yield* new ConnectionError({
          message: "Unknown connection request.",
        })
      return { connections: yield* Effect.tryPromise(() => connections.list()) }
    })
  )
}
