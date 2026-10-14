import { Effect, Semaphore } from "effect"
import type { MCPClientManager } from "agents/mcp/client"
import {
  ConnectionError,
  remoteTool,
  type ConnectionInfo,
  type NewConnection,
  type RemoteTool,
} from "../connections"
import type { ConnectionStore } from "./connections"
import { toolReceipt } from "./receipt"
import type { ToolExecutionResult } from "@earendil-works/pi-durable"

export class RemoteConnections {
  private readonly mutations = Semaphore.makeUnsafe(1)
  constructor(
    readonly store: ConnectionStore,
    readonly mcp: MCPClientManager
  ) {}
  async list(): Promise<ConnectionInfo[]> {
    const servers = this.mcp.listServers()
    return Promise.all(
      this.store.list().map(async (record) => {
        const live = this.mcp.mcpConnections[record.id]
        const server = servers.find((value) => value.id === record.id)
        const status = !record.active
          ? "disconnected"
          : live?.connectionState === "ready"
            ? "ready"
            : live?.connectionState === "authenticating"
              ? "authorization"
              : live?.connectionState === "failed" || !live
                ? "unavailable"
                : "connecting"
        let tools: RemoteTool[] = []
        if (record.active && live?.connectionState === "ready")
          tools = (
            await Promise.all(
              this.mcp
                .listTools({ serverId: record.id })
                .slice(0, 100)
                .map((tool) => remoteTool(record, tool).catch(() => null))
            )
          ).filter((tool): tool is RemoteTool => tool !== null)
        return {
          ...record,
          status,
          authorizeUrl:
            status === "authorization" && server?.auth_url
              ? safeAuthorizeUrl(server.auth_url)
              : null,
          tools,
        }
      })
    )
  }
  change(work: () => Promise<void>) {
    return this.mutations.withPermit(
      Effect.tryPromise({
        try: work,
        catch: (cause) =>
          cause instanceof ConnectionError
            ? cause
            : new ConnectionError({
                message:
                  "Could not connect. This server must support public HTTPS MCP and, if required, OAuth registration. Reload to check its status.",
              }),
      })
    )
  }
  connect(input: NewConnection, origin: string) {
    return this.change(async () => {
      const record = this.store.add(input)
      if (!record.active) throw new Error("Connection disconnected")
      if (this.mcp.listServers().some((server) => server.id === record.id))
        return
      await this.register(record, origin)
    })
  }
  private async register(record: NewConnection, origin: string) {
    await this.mcp.registerServer(record.id, {
      name: record.name,
      url: record.url,
      callbackUrl: `${origin}/api/agent/connections/callback`,
      transport: {
        type: "streamable-http",
        requestInit: { redirect: "manual" },
        onInsufficientScope: "throw",
        maxStepUpRetries: 0,
        reconnectionOptions: {
          maxRetries: 0,
          initialReconnectionDelay: 1000,
          maxReconnectionDelay: 1000,
          reconnectionDelayGrowFactor: 1,
        },
      },
      client: { listMaxPages: 2, inputRequired: { autoFulfill: false } },
      retry: { maxAttempts: 1 },
    })
    const result = await this.mcp.connectToServer(record.id)
    if (result.state === "connected")
      await this.mcp.discoverIfConnected(record.id, { timeoutMs: 20_000 })
  }
  disconnect(id: string, revision: number) {
    return this.change(async () => {
      this.store.change(id, revision, false)
      await this.mcp.removeServer(id)
    })
  }
  reconnect(id: string, revision: number, origin: string) {
    return this.change(async () => {
      const replay = this.store.get(id)?.revision === revision + 1
      const record = this.store.change(id, revision, true)
      if (replay && this.mcp.listServers().some((server) => server.id === id))
        return
      await this.mcp.removeServer(id)
      await this.register(record, origin)
    })
  }
  refresh(id: string) {
    return this.change(async () => {
      if (!this.store.get(id)?.active) throw new Error("Disconnected")
      await this.mcp.discoverIfConnected(id, { timeoutMs: 20_000 })
    })
  }
  callback(request: Request) {
    return this.change(async () => {
      if (!this.mcp.isCallbackRequest(request))
        throw new Error("Unknown callback")
      const result = await this.mcp.handleCallbackRequest(request)
      if (!result.authSuccess || !this.store.get(result.serverId)?.active)
        throw new Error("Authorization failed")
      await this.mcp.establishConnection(result.serverId)
    })
  }
  async resolve(names: readonly string[]) {
    try {
      await this.mcp.waitForConnections({ timeout: 20_000 })
      const catalog = (await this.list()).flatMap(
        (connection) => connection.tools
      )
      const tools = names.map((name) => {
        const found = catalog.find((tool) => tool.name === name)
        if (!found) throw new Error("Unavailable")
        return found
      })
      return { tools, error: null }
    } catch {
      return {
        tools: [],
        error:
          "A selected tool is unavailable or has changed. Refresh its connection.",
      }
    }
  }
  async call(
    name: string,
    args: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    try {
      const resolved = await this.resolve([name])
      if (resolved.error || !resolved.tools[0]) throw new Error("Unavailable")
      const reference = resolved.tools[0]
      const current = this.store.get(reference.connectionId)
      if (!current?.active || current.revision !== reference.connectionRevision)
        throw new Error("Revoked")
      const result = await this.mcp.callTool(
        {
          serverId: reference.connectionId,
          name: `${reference.connectionId}.${reference.remoteName}`,
          arguments: args,
        },
        {
          toolDefinition: {
            name: reference.remoteName,
            description: reference.description,
            inputSchema: reference.parameters as { type: "object" },
          },
          timeout: 60_000,
          maxTotalTimeout: 60_000,
          resetTimeoutOnProgress: false,
        }
      )
      const content: NonNullable<ToolExecutionResult["content"]>[number][] = []
      for (const block of result.content) {
        if (block.type === "text")
          content.push({ type: "text", text: block.text })
        else if (block.type === "image")
          content.push({
            type: "image",
            data: block.data,
            mimeType: block.mimeType,
          })
        else
          content.push({
            type: "text",
            text: "The server returned a resource format that this chat cannot display yet.",
          })
      }
      if (!content.length && result.structuredContent !== undefined)
        content.push({
          type: "text",
          text: JSON.stringify(result.structuredContent),
        })
      return toolReceipt({ content, isError: result.isError })
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "The connected tool could not complete. Check the connection and the remote service before retrying; an external action may have started.",
          },
        ],
        isError: true,
      }
    }
  }
}
function safeAuthorizeUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : null
  } catch {
    return null
  }
}
