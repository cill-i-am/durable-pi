import { Schema } from "effect"

export const ConnectionId = Schema.String.check(
  Schema.isPattern(/^mcp-[a-f0-9]{32}$/)
)
const Revision = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0)
)
export const NewConnection = Schema.Struct({
  id: ConnectionId,
  name: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(80),
    Schema.isPattern(/\S/)
  ),
  url: Schema.String.check(Schema.isMaxLength(2000)),
})
export type NewConnection = typeof NewConnection.Type
export const ChangeConnection = Schema.Struct({
  id: ConnectionId,
  expectedRevision: Revision,
})
export const RemoteTool = Schema.Struct({
  name: Schema.String,
  connectionId: ConnectionId,
  connectionRevision: Revision,
  connectionName: Schema.String,
  remoteName: Schema.String,
  description: Schema.String,
  parameters: Schema.Record(Schema.String, Schema.Unknown),
})
export type RemoteTool = typeof RemoteTool.Type
export const ConnectionInfo = Schema.Struct({
  ...NewConnection.fields,
  revision: Revision,
  active: Schema.Boolean,
  status: Schema.Literals([
    "disconnected",
    "connecting",
    "authorization",
    "ready",
    "unavailable",
  ]),
  authorizeUrl: Schema.NullOr(Schema.String),
  tools: Schema.Array(RemoteTool),
})
export type ConnectionInfo = typeof ConnectionInfo.Type
export const ConnectionList = Schema.Struct({
  connections: Schema.Array(ConnectionInfo),
})
export const ToolSelection = Schema.Struct({
  revision: Revision,
  tools: Schema.Array(RemoteTool),
})
export type ToolSelection = typeof ToolSelection.Type
export const SelectRemoteTools = Schema.Struct({
  expectedRevision: Revision,
  names: Schema.Array(
    Schema.String.check(Schema.isPattern(/^mcp_[a-f0-9]{40}$/))
  ).check(Schema.isMaxLength(16)),
})
export class ConnectionError extends Schema.TaggedError<ConnectionError>()(
  "ConnectionError",
  { message: Schema.String }
) {}

export function connectionUrl(value: string) {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.port ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(url.hostname) ||
    /(^|\.)(localhost|local|internal|test|invalid|example)$/.test(url.hostname)
  )
    throw new ConnectionError({
      message:
        "Use a public HTTPS MCP endpoint without a query, credentials, or custom port.",
    })
  return url.href
}

export async function remoteTool(
  connection: NewConnection & { revision: number },
  tool: {
    name: string
    description?: string
    inputSchema: Record<string, unknown>
  }
): Promise<RemoteTool> {
  const parameters = tool.inputSchema
  if (
    !tool.name ||
    tool.name.length > 120 ||
    parameters.type !== "object" ||
    new TextEncoder().encode(JSON.stringify(parameters)).byteLength > 32_000
  )
    throw new ConnectionError({
      message: "This server returned an unsupported tool definition.",
    })
  const description = (tool.description ?? tool.name).slice(0, 2000)
  const identity = JSON.stringify([
    connection.id,
    connection.revision,
    tool.name,
    description,
    parameters,
  ])
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity))
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("")
  return {
    name: `mcp_${hash.slice(0, 40)}`,
    connectionId: connection.id,
    connectionRevision: connection.revision,
    connectionName: connection.name,
    remoteName: tool.name,
    description,
    parameters,
  }
}
