import type { Effect } from "effect"

import type {
  SavedConnection,
  RemoteTool,
  RemoteToolResult,
  ConnectionTransportError,
} from "./connections"

export type RemoteConnectionState = {
  registered: boolean
  phase: "ready" | "authorization" | "unavailable" | "connecting"
  authorizeUrl: string | null
}
/** Platform capabilities only. Each interrupted native operation must settle
 * before its Effect exits, so application mutation permits retain ownership. */
export interface ConnectionClient {
  inspect: (
    id: string
  ) => Effect.Effect<RemoteConnectionState, ConnectionTransportError>
  tools: (
    record: SavedConnection
  ) => Effect.Effect<RemoteTool[], ConnectionTransportError>
  register: (
    record: SavedConnection,
    origin: string
  ) => Effect.Effect<void, ConnectionTransportError>
  connect: (
    record: SavedConnection
  ) => Effect.Effect<boolean, ConnectionTransportError>
  remove: (id: string) => Effect.Effect<void, ConnectionTransportError>
  discover: (id: string) => Effect.Effect<void, ConnectionTransportError>
  isCallback: (
    request: Request
  ) => Effect.Effect<boolean, ConnectionTransportError>
  callback: (
    request: Request,
    eligible: () => boolean
  ) => Effect.Effect<
    {
      authenticated: boolean
      connectionId: string | undefined
      revision: number
    },
    ConnectionTransportError
  >
  establish: (id: string) => Effect.Effect<void, ConnectionTransportError>
  ready: () => Effect.Effect<void, ConnectionTransportError>
  call: (
    tool: RemoteTool,
    input: Record<string, unknown>
  ) => Effect.Effect<RemoteToolResult, ConnectionTransportError>
  settle: () => Effect.Effect<void>
}
