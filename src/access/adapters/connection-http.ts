import { Effect, Schema } from "effect"

import { preserveFatal } from "../../shared/effect"
import { jsonRequest } from "../../shared/http"
import type { RemoteConnectionOperations } from "../connection-service"
import {
  ChangeConnection,
  ConnectionError,
  ConnectionId,
  NewConnection,
  type ConnectionStorageError,
  type ConnectionTransportError,
} from "../connections"

class ConnectionRequestInvalid extends Schema.TaggedError<ConnectionRequestInvalid>()(
  "ConnectionRequestInvalid",
  {}
) {}

export const connectionDecode = <T, TRequirements>(
  schema: Schema.ConstraintDecoder<T, TRequirements>,
  input: unknown
) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    preserveFatal,
    Effect.mapError(() => new ConnectionRequestInvalid())
  )

export const connectionJson = (request: Request) =>
  jsonRequest(
    request,
    Schema.Unknown,
    16_000,
    () => new ConnectionRequestInvalid()
  )

const rejected = (error: string) =>
  Effect.succeed(Response.json({ error }, { status: 409 }))
const incomplete = () =>
  rejected(
    "The connection request could not be completed. Reload and try again."
  )
const callbackResponse = (result: "connected" | "failed") =>
  new Response(null, {
    status: 303,
    headers: {
      Location: `/?connections=${result}`,
      "Referrer-Policy": "no-referrer",
    },
  })
const callbackFailed = () => Effect.sync(() => callbackResponse("failed"))

export function connectionResponse<T, TRequirements>(
  work: Effect.Effect<
    T,
    | ConnectionError
    | ConnectionStorageError
    | ConnectionTransportError
    | ConnectionRequestInvalid,
    TRequirements
  >
): Effect.Effect<Response, never, TRequirements> {
  return work.pipe(
    Effect.map((value) => Response.json(value)),
    preserveFatal,
    Effect.catchTags({
      ConnectionError: (error) => rejected(error.message),
      ConnectionTransportError: () =>
        rejected(
          "Could not connect. This server must support public HTTPS MCP and, if required, OAuth registration. Reload to check its status."
        ),
      ConnectionStorageError: incomplete,
      ConnectionRequestInvalid: incomplete,
    })
  )
}
export function connectionRequest(
  connections: RemoteConnectionOperations,
  request: Request,
  path: string,
  origin: string
) {
  if (path === "connections/callback") {
    const publicRequest = new Request(
      `${origin}${new URL(request.url).pathname}${new URL(request.url).search}`,
      { method: request.method, signal: request.signal }
    )
    return connections.callback(publicRequest).pipe(
      Effect.map(() => callbackResponse("connected")),
      preserveFatal,
      Effect.catchTags({
        ConnectionError: callbackFailed,
        ConnectionStorageError: callbackFailed,
        ConnectionTransportError: callbackFailed,
      })
    )
  }
  return connectionResponse(
    Effect.gen(function* () {
      if (request.method === "GET" && path === "connections")
        return {
          connections: yield* connections.list(),
        }
      if (request.method !== "POST")
        return yield* new ConnectionError({
          message: "Use POST to change connections.",
        })
      const input = yield* connectionJson(request)
      if (path === "connections/add") {
        const body = yield* connectionDecode(NewConnection, input)
        yield* connections.connect(body, origin)
      } else if (
        path === "connections/disconnect" ||
        path === "connections/reconnect"
      ) {
        const body = yield* connectionDecode(ChangeConnection, input)
        yield* path.endsWith("/disconnect")
          ? connections.disconnect(body.id, body.expectedRevision)
          : connections.reconnect(body.id, body.expectedRevision, origin)
      } else if (path === "connections/refresh") {
        const body = yield* connectionDecode(
          Schema.Struct({ id: ConnectionId }),
          input
        )
        yield* connections.refresh(body.id)
      } else
        return yield* new ConnectionError({
          message: "Unknown connection request.",
        })
      return { connections: yield* connections.list() }
    })
  )
}
