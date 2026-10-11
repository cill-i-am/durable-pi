import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import type { MCPClientManager } from "agents/mcp/client"
import { database } from "./database"
import { ConnectionStore } from "../src/access/adapters/connections"
import { RemoteConnections } from "../src/access/adapters/mcp"
import { connectionUrl, remoteTool } from "../src/access/connections"
import { selectRemoteTools } from "../src/access/remote-selection"
import { AccessStore } from "../src/access/adapters/sqlite"

const input = {
  id: `mcp-${"a".repeat(32)}`,
  name: "Synthetic",
  url: "https://mcp.example.com/mcp",
}
const definition = {
  name: "read",
  description: "Read synthetic data",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
}
function fixture() {
  const store = new ConnectionStore(database())
  store.add(input)
  const calls: unknown[] = []
  const mcp = {
    listServers: () => [{ id: input.id }],
    mcpConnections: { [input.id]: { connectionState: "ready" } },
    listTools: () => [definition],
    waitForConnections: async () => {},
    callTool: async (args: unknown) => {
      calls.push(args)
      return { content: [{ type: "text", text: "Synthetic result" }] }
    },
    removeServer: vi.fn(async () => {}),
    registerServer: vi.fn(async () => {}),
  }
  return {
    store,
    calls,
    mcp,
    connections: new RemoteConnections(
      store,
      mcp as unknown as MCPClientManager
    ),
  }
}
describe("connection authority", () => {
  it.each([
    "http://mcp.example.com",
    "https://localhost",
    "https://127.0.0.1",
    "https://[::1]",
    "https://169.254.169.254",
    "https://private.internal",
    "https://mcp.example.com:8443",
    "https://user:password@mcp.example.com",
    "https://mcp.example.com/?token=secret",
    "https://mcp.example.com/#token",
  ])("rejects unsupported endpoint %s", (value) =>
    expect(() => connectionUrl(value)).toThrow()
  )
  it("accepts public HTTPS endpoints and pins tools to connection generation and schema", async () => {
    expect(connectionUrl(input.url)).toBe(input.url)
    const first = await remoteTool({ ...input, revision: 1 }, definition)
    expect(await remoteTool({ ...input, revision: 1 }, definition)).toEqual(
      first
    )
    expect(
      (await remoteTool({ ...input, revision: 2 }, definition)).name
    ).not.toBe(first.name)
    expect(
      (
        await remoteTool(
          { ...input, revision: 1 },
          { ...definition, description: "Changed scope" }
        )
      ).name
    ).not.toBe(first.name)
    expect(
      (
        await remoteTool(
          { ...input, revision: 1 },
          {
            ...definition,
            inputSchema: {
              type: "object",
              properties: { other: { type: "boolean" } },
            },
          }
        )
      ).name
    ).not.toBe(first.name)
  })
  it("disconnects before transport cleanup, fences stale mutation, and safely replays reconnect", async () => {
    const { store, mcp, connections } = fixture()
    mcp.removeServer.mockImplementation(async () => {
      throw new Error("private-provider-secret")
    })
    await expect(
      Effect.runPromise(connections.disconnect(input.id, 1))
    ).rejects.toThrow("Could not connect")
    expect(store.get(input.id)?.active).toBe(false)
    expect(store.get(input.id)?.revision).toBe(2)
    expect(() => store.change(input.id, 1, true)).toThrow("changed")
    store.change(input.id, 2, true)
    mcp.removeServer.mockClear()
    await Effect.runPromise(
      connections.reconnect(input.id, 2, "https://app.example.com")
    )
    expect(mcp.removeServer).not.toHaveBeenCalled()
    expect(store.get(input.id)?.revision).toBe(3)
  })
  it("uses authoritative remote names and refuses old tool identities after reconnect", async () => {
    const { connections, calls, store } = fixture()
    const tool = (await connections.list())[0]!.tools[0]!
    expect(
      (await connections.call(tool.name, { value: "Synthetic" })).isError
    ).not.toBe(true)
    expect(calls).toEqual([
      {
        serverId: input.id,
        name: `${input.id}.read`,
        arguments: { value: "Synthetic" },
      },
    ])
    store.change(input.id, 1, true)
    expect((await connections.call(tool.name, {})).isError).toBe(true)
    expect(calls).toHaveLength(1)
  })
  it("rechecks revocation after waiting for a connection and never dispatches a revoked call", async () => {
    const { store, mcp, connections, calls } = fixture()
    const tool = (await connections.list())[0]!.tools[0]!
    mcp.waitForConnections = async () => {
      store.change(input.id, 1, false)
    }
    expect((await connections.call(tool.name, {})).isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
  it("preserves structured-only results as bounded model content", async () => {
    const { mcp, connections } = fixture()
    const tool = (await connections.list())[0]!.tools[0]!
    Object.assign(mcp, {
      callTool: async () => ({
        content: [],
        structuredContent: { answer: "Synthetic result" },
        _meta: { secret: "private-provider-secret" },
      }),
    })
    expect(await connections.call(tool.name, {})).toEqual({
      content: [{ type: "text", text: '{"answer":"Synthetic result"}' }],
      isError: undefined,
    })
  })
  it("isolates malformed tools and removes transport errors from responses", async () => {
    const { mcp, connections } = fixture()
    mcp.listTools = () => [
      definition,
      {
        ...definition,
        name: "invalid",
        inputSchema: { ...definition.inputSchema, type: "string" },
      },
    ]
    expect((await connections.list())[0]?.tools).toHaveLength(1)
    const tool = (await connections.list())[0]!.tools[0]!
    mcp.callTool = async () => {
      throw new Error("private-provider-secret")
    }
    expect(JSON.stringify(await connections.call(tool.name, {}))).not.toContain(
      "private-provider-secret"
    )
  })
})
describe("per-bot connected tool selection", () => {
  it("retains pinned offline tools while removing another and rejects stale replacement", async () => {
    const first = new ConnectionStore(database()),
      second = new ConnectionStore(database())
    const a = await remoteTool({ ...input, revision: 1 }, definition)
    const b = await remoteTool(
      { ...input, revision: 1 },
      { ...definition, name: "other" }
    )
    first.select(0, [a, b])
    const resolve = vi.fn(async () => ({ tools: [], error: "Offline" }))
    const saved = await Effect.runPromise(
      selectRemoteTools(
        first,
        { expectedRevision: 1, names: [a.name] },
        resolve,
        () => true
      )
    )
    expect(saved.tools).toEqual([a])
    expect(resolve).not.toHaveBeenCalled()
    expect(second.selection().tools).toEqual([])
    await expect(
      Effect.runPromise(
        selectRemoteTools(
          first,
          { expectedRevision: 1, names: [] },
          resolve,
          () => true
        )
      )
    ).rejects.toThrow("changed")
  })
  it("checks archival after resolving and makes unknown remote tools Ask by default", async () => {
    const first = new ConnectionStore(database()),
      tool = await remoteTool({ ...input, revision: 1 }, definition)
    let writable = true
    await expect(
      Effect.runPromise(
        selectRemoteTools(
          first,
          { expectedRevision: 0, names: [tool.name] },
          async () => {
            writable = false
            return { tools: [tool], error: null }
          },
          () => writable
        )
      )
    ).rejects.toThrow("Restore")
    expect(first.selection().tools).toEqual([])
    first.select(0, [tool])
    const access = new AccessStore(database(), () =>
      first.selection().tools.map((value) => ({
        name: value.name,
        description: value.description,
        mode: "ask",
      }))
    )
    const id = crypto.randomUUID()
    expect(
      access.begin({ id, turnId: "turn", tool: tool.name, input: "{}" }).status
    ).toBe("pending")
    access.update(tool.name, 0, "allow")
    access.revoke(tool.name)
    expect(access.get(id)?.status).toBe("denied")
    expect(access.policy(tool.name).mode).toBe("ask")
    expect(access.policy(tool.name).revision).toBe(2)
  })
})
