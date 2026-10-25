import type { RemoteConnectionState } from "./connection-client"
import { advanceConnection } from "./connection.machine"
import {
  ConnectionError,
  connectionUrl,
  type NewConnection,
  type SavedConnection,
  type RemoteTool,
  type ToolSelection,
  type ConnectionInfo,
} from "./connections"

export function addConnection(
  input: NewConnection,
  previous: SavedConnection | undefined,
  count: number
): SavedConnection {
  const url = connectionUrl(input.url)
  if (previous) {
    if (previous.url !== url || previous.name !== input.name)
      throw new ConnectionError({
        message: "This connection ID is already in use.",
      })
    return previous
  }
  if (count >= 20)
    throw new ConnectionError({
      message: "This workspace supports up to 20 connection records.",
    })
  return { ...input, url, revision: 1, active: true }
}
export function changeConnection(
  current: SavedConnection | undefined,
  expectedRevision: number,
  active: boolean
): SavedConnection {
  if (!current) throw new ConnectionError({ message: "Connection not found." })
  return advanceConnection(current, {
    type: active ? "ACTIVATE" : "DISCONNECT",
    expectedRevision,
  })
}
export function selectTools(
  current: ToolSelection,
  expectedRevision: number,
  tools: readonly RemoteTool[]
): ToolSelection {
  if (
    tools.length > 16 ||
    new Set(tools.map((tool) => tool.name)).size !== tools.length
  )
    throw new ConnectionError({ message: "Choose up to 16 distinct tools." })
  const serialized = JSON.stringify(tools)
  if (current.revision !== expectedRevision) {
    if (
      current.revision === expectedRevision + 1 &&
      JSON.stringify(current.tools) === serialized
    )
      return current
    throw new ConnectionError({
      message: "The selected tools changed. Reload before updating them.",
    })
  }
  if (new TextEncoder().encode(serialized).byteLength > 600_000)
    throw new ConnectionError({
      message: "These tool definitions exceed the selection limit.",
    })
  return { revision: current.revision + 1, tools: [...tools] }
}
export function requireSelectionWrite(canWrite: boolean) {
  if (!canWrite)
    throw new ConnectionError({
      message: "Restore this bot before changing its tools.",
    })
}
export function requireActiveConnection(
  connection: SavedConnection | undefined
) {
  if (!connection?.active)
    throw new ConnectionError({
      message: "This connection is disconnected. Reconnect before using it.",
    })
}
export function requireToolGeneration(
  connection: SavedConnection | undefined,
  tool: RemoteTool
) {
  if (!connection?.active || connection.revision !== tool.connectionRevision)
    throw new ConnectionError({
      message: "This tool's connection changed. Refresh before using it.",
    })
}
export function describeConnection(
  record: SavedConnection,
  state: RemoteConnectionState,
  tools: RemoteTool[]
): ConnectionInfo {
  const status = record.active ? state.phase : "disconnected"
  let authorizeUrl: string | null = null
  if (status === "authorization" && state.authorizeUrl) {
    try {
      const url = new URL(state.authorizeUrl)
      if (url.protocol === "https:" && !url.username && !url.password)
        authorizeUrl = url.href
    } catch {}
  }
  return { ...record, status, authorizeUrl, tools }
}

export function requireConnectionWrite(eligible: boolean) {
  if (!eligible)
    throw new ConnectionError({
      message:
        "Connection authority changed or expired. Reload before updating it.",
    })
}
