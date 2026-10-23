import type { ToolExecutionResult } from "@earendil-works/pi-durable"
import type { MCPClientManager } from "agents/mcp/client"
import { Schema, Effect } from "effect"

import { preserveFatal } from "../../shared/effect"
import { nativeFailure, nativeOperation } from "../../shared/interop"
import type { ConnectionClient } from "../connection-client"
import {
  ConnectionError,
  ConnectionTransportError,
  prepareRemoteTool,
  identifyRemoteTool,
  type RemoteToolResult,
} from "../connections"
import { ConnectionOAuthProvider } from "./oauth"
import { toolReceipt } from "./receipt"

export type McpManager = Pick<
  MCPClientManager,
  | "listServers"
  | "mcpConnections"
  | "listTools"
  | "registerServer"
  | "connectToServer"
  | "discoverIfConnected"
  | "removeServer"
  | "isCallbackRequest"
  | "handleCallbackRequest"
  | "establishConnection"
  | "waitForConnections"
  | "callTool"
>

/** SDK work has an independent lifetime. An interrupted Effect joins that work
 * before releasing its caller's permit; the manager's Lifecycle owns disposal. */
export function mcpConnectionClient(mcp: McpManager): ConnectionClient {
  const pending = new Set<Promise<unknown>>()
  const rejected =
    (operation: string) =>
    (cause: unknown, channel: "failure" | "rejection") => {
      const expected = Schema.decodeUnknownOption(ConnectionTransportError)(
        cause
      )
      if (expected._tag === "Some") return expected.value
      if (
        channel === "failure" ||
        Schema.isSchemaError(cause) ||
        cause instanceof SyntaxError
      )
        throw cause
      return new ConnectionTransportError({ operation, cause })
    }
  const native = <T>(
    operation: string,
    body: (signal: AbortSignal) => Promise<T>
  ) =>
    nativeOperation((signal) => {
      const task = body(signal)
      pending.add(task)
      return task.then(
        (value) => {
          pending.delete(task)
          return value
        },
        (cause) => {
          pending.delete(task)
          throw cause
        }
      )
    }, rejected(operation))
  const read = <T>(operation: string, body: () => T) =>
    Effect.suspend(() => {
      try {
        return Effect.succeed(body())
      } catch (cause) {
        return Effect.failCause(nativeFailure(cause, rejected(operation)))
      }
    })
  const discover = (id: string) =>
    native("discover", () =>
      mcp.discoverIfConnected(id, { timeoutMs: 20_000 })
    ).pipe(Effect.asVoid)
  return {
    inspect: (id) =>
      read("inspect", () => mcp.listServers()).pipe(
        Effect.map((servers) => {
          const server = servers.find((value) => value.id === id)
          const live = mcp.mcpConnections[id]
          return {
            registered: !!server,
            phase:
              live?.connectionState === "ready"
                ? "ready"
                : live?.connectionState === "authenticating"
                  ? "authorization"
                  : live?.connectionState === "failed" || !live
                    ? "unavailable"
                    : "connecting",
            authorizeUrl: server?.auth_url ?? null,
          }
        })
      ),
    tools: (record) =>
      Effect.gen(function* () {
        const tools = yield* read("list tools", () =>
          mcp.listTools({ serverId: record.id })
        ).pipe(Effect.map((values) => values.slice(0, 100)))
        const normalized = yield* Effect.forEach(
          tools,
          (tool) =>
            Effect.gen(function* () {
              const prepared = yield* Effect.try({
                try: () => prepareRemoteTool(record, tool),
                catch: (cause) => {
                  const connectionError =
                    Schema.decodeUnknownOption(ConnectionError)(cause)
                  if (connectionError._tag === "Some")
                    return connectionError.value
                  throw cause
                },
              })
              const digest = yield* native("derive tool identity", () =>
                crypto.subtle.digest(
                  "SHA-256",
                  new TextEncoder().encode(prepared.identity)
                )
              )
              return identifyRemoteTool(
                prepared.reference,
                new Uint8Array(digest)
              )
            }).pipe(
              preserveFatal,
              Effect.catchTag("ConnectionError", () => Effect.succeed(null))
            ),
          { concurrency: 4 }
        )
        return normalized.filter((tool) => tool !== null)
      }),
    register: (record, origin) =>
      Effect.gen(function* () {
        yield* native("register", () =>
          mcp.registerServer(record.id, {
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
        )
      }),
    connect: (record) =>
      native("connect", () => mcp.connectToServer(record.id)).pipe(
        Effect.map((result) => result.state === "connected")
      ),
    remove: (id) => native("remove", () => mcp.removeServer(id)),
    discover,
    isCallback: (request) =>
      read("inspect callback", () => mcp.isCallbackRequest(request)),
    callback: (request, eligible) =>
      native("authorize", async (signal) => {
        const state = new URL(request.url).searchParams.get("state")
        // Routing only: the installed provider validates the complete state.
        const id = state?.split(".")[1]
        const provider = id
          ? mcp.mcpConnections[id]?.options.transport.authProvider
          : undefined
        const revision =
          state && provider instanceof ConnectionOAuthProvider
            ? await provider.callbackRevision(state)
            : undefined
        if (revision === undefined || !eligible())
          throw new ConnectionTransportError({
            operation: "authorize",
            cause: new Error(
              "Authorization expired or its connection changed. Reconnect before authorizing it."
            ),
          })
        const result = await mcp.handleCallbackRequest(
          new Request(request, {
            signal: AbortSignal.any([request.signal, signal]),
          })
        )
        return {
          authenticated: result.authSuccess && result.serverId === id,
          connectionId: id,
          revision,
        }
      }),
    establish: (id) => native("establish", () => mcp.establishConnection(id)),
    ready: () =>
      native("await connections", () =>
        mcp.waitForConnections({ timeout: 20_000 })
      ),
    call: (reference, input) =>
      native("call tool", (signal) =>
        mcp.callTool(
          {
            serverId: reference.connectionId,
            name: `${reference.connectionId}.${reference.remoteName}`,
            arguments: input,
          },
          {
            signal,
            toolDefinition: {
              name: reference.remoteName,
              description: reference.description,
              inputSchema: { ...reference.parameters, type: "object" },
            },
            timeout: 60_000,
            maxTotalTimeout: 60_000,
            resetTimeoutOnProgress: false,
          }
        )
      ).pipe(
        Effect.map((result): RemoteToolResult => {
          const content: NonNullable<ToolExecutionResult["output"]>[number][] =
            []
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
          const bounded = toolReceipt({
            output: content,
            isError: result.isError,
          })
          return {
            content: bounded.output ?? [],
            isError: bounded.isError,
            ...(bounded.diagnostics
              ? { diagnostics: bounded.diagnostics }
              : {}),
          }
        })
      ),
    settle: () =>
      Effect.promise(async () => {
        while (pending.size) await Promise.allSettled([...pending])
      }),
  }
}
