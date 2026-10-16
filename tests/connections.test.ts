import { it as effectIt } from "@effect/vitest"
import type { MCPClientManager } from "agents/mcp/client"
import { Cause, Effect, Exit, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vitest"

import { connectionRequest } from "../src/access/adapters/connection-http"
import {
  ConnectionStore,
  sqliteRemoteSelection,
} from "../src/access/adapters/connections"
import { remoteTool } from "../src/access/adapters/remote-tool"
import { AccessStore } from "../src/access/adapters/sqlite"
import { connectionUrl, ConnectionError } from "../src/access/connections"
import { selectRemoteTools } from "../src/access/remote-selection"
import { connectionFixture } from "./connection-fixture"
import { database } from "./database"

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
  const db = database(),
    store = new ConnectionStore(db)
  Effect.runSync(store.add(input))
  const calls: unknown[] = []
  const mcp = {
    listServers: () => [{ id: input.id }],
    mcpConnections: { [input.id]: { connectionState: "ready" } },
    listTools: () => [definition],
    waitForConnections: async () => {},
    callTool: async (args: unknown, _options?: { signal?: AbortSignal }) => {
      calls.push(args)
      return { content: [{ type: "text", text: "Synthetic result" }] }
    },
    removeServer: vi.fn(async () => {}),
    registerServer: vi.fn(async () => {}),
    connectToServer: vi.fn(async () => ({ state: "connected" as const })),
    discoverIfConnected: vi.fn(async () => {}),
  }
  const { runtime, service: connections } = connectionFixture(
    store,
    mcp as unknown as MCPClientManager
  )
  return {
    store,
    db,
    calls,
    mcp,
    connections,
    runtime,
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
describe("connection authority", () => {
  effectIt.effect(
    "expires mutation continuation on the Effect clock while joining native registration",
    () =>
      Effect.gen(function* () {
        const f = fixture(),
          started = deferred<void>(),
          settled = deferred<void>()
        f.mcp.listServers = () => []
        f.mcp.registerServer.mockImplementation(async () => {
          started.resolve()
          await settled.promise
        })
        let finished = false
        const pending = yield* Effect.forkChild(
          f.connections.connect(input, "https://app.example.com").pipe(
            Effect.result,
            Effect.tap(() =>
              Effect.sync(() => {
                finished = true
              })
            )
          )
        )
        yield* Effect.promise(() => started.promise)
        yield* TestClock.adjust("60 seconds")
        expect(finished).toBe(false)
        expect(f.mcp.connectToServer).not.toHaveBeenCalled()
        settled.resolve()
        expect(yield* Fiber.join(pending)).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "ConnectionTransportError",
            operation: "connection deadline",
          },
        })
        expect(f.mcp.connectToServer).not.toHaveBeenCalled()
        yield* f.connections.disconnect(input.id, 1)
        expect((yield* f.store.get(input.id))?.active).toBe(false)
      })
  )
  it("holds the mutation permit through interrupted native registration and skips later connection steps", async () => {
    const f = fixture(),
      started = deferred<void>(),
      settled = deferred<void>()
    f.mcp.listServers = () => []
    f.mcp.registerServer.mockImplementation(async () => {
      started.resolve()
      await settled.promise
    })
    const controller = new AbortController()
    let interrupted = false
    const request = Effect.runPromiseExit(
      f.connections.connect(input, "https://app.example.com"),
      { signal: controller.signal }
    ).then((exit) => {
      interrupted = true
      return exit
    })
    await started.promise
    controller.abort()
    const disconnect = Effect.runPromise(f.connections.disconnect(input.id, 1))
    expect(Effect.runSync(f.store.get(input.id))?.active).toBe(true)
    expect(f.mcp.removeServer).not.toHaveBeenCalled()
    expect(interrupted).toBe(false)
    settled.resolve()
    const exit = await request
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await disconnect
    expect(f.mcp.connectToServer).not.toHaveBeenCalled()
    expect(f.mcp.discoverIfConnected).not.toHaveBeenCalled()
    expect(f.mcp.removeServer).toHaveBeenCalledOnce()
    expect(Effect.runSync(f.store.get(input.id))?.active).toBe(false)
  })
  it("propagates tool cancellation and waits for a noncooperative call before disposing the actor service", async () => {
    const f = fixture(),
      started = deferred<void>(),
      aborted = deferred<void>(),
      settled = deferred<void>()
    const tool = (await Effect.runPromise(f.connections.list()))[0]!.tools[0]!
    f.mcp.callTool = async (_, options) => {
      options?.signal?.addEventListener("abort", () => aborted.resolve(), {
        once: true,
      })
      started.resolve()
      await settled.promise
      return { content: [{ type: "text", text: "Late result" }] }
    }
    const controller = new AbortController()
    let finished = false
    const request = Effect.runPromiseExit(f.connections.call(tool.name, {}), {
      signal: controller.signal,
    }).then((exit) => {
      finished = true
      return exit
    })
    await started.promise
    controller.abort()
    await aborted.promise
    let disposed = false
    const disposal = f.runtime.dispose().then(() => {
      disposed = true
    })
    await vi.waitFor(async () => {
      await expect(Effect.runPromise(f.connections.list())).rejects.toThrow(
        "host has stopped"
      )
    })
    expect(finished).toBe(false)
    expect(disposed).toBe(false)
    settled.resolve()
    const exit = await request
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
    await disposal
    expect(disposed).toBe(true)
  })
  it("preserves corrupt-record defects through resolution rather than treating them as unavailable transport", async () => {
    const f = fixture()
    f.db.run("UPDATE access_connections SET name='' WHERE id=?", input.id)
    const exit = await Effect.runPromise(
      Effect.exit(f.connections.resolve(["tool"]))
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  })
  it("keeps durable connection-write failures separate from transport failures", async () => {
    const f = fixture()
    f.db.run(
      "CREATE TRIGGER reject_connection BEFORE UPDATE ON access_connections BEGIN SELECT RAISE(ABORT,'write failure'); END"
    )
    expect(
      await Effect.runPromise(
        f.connections.disconnect(input.id, 1).pipe(Effect.result)
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConnectionStorageError" },
    })
    expect(f.mcp.removeServer).not.toHaveBeenCalled()
    expect(Effect.runSync(f.store.get(input.id))?.active).toBe(true)
  })
  it("maps native transport failures only at HTTP without exposing their cause", async () => {
    const f = fixture()
    f.mcp.removeServer.mockRejectedValue(new Error("private-provider-secret"))
    const response = await Effect.runPromise(
      connectionRequest(
        f.connections,
        new Request("https://app.example.com", {
          method: "POST",
          body: JSON.stringify({ id: input.id, expectedRevision: 1 }),
        }),
        "connections/disconnect",
        "https://app.example.com"
      )
    )
    expect(response.status).toBe(409)
    const body = await response.text()
    expect(body).toContain("Could not connect")
    expect(body).not.toContain("private-provider-secret")
    expect(Effect.runSync(f.store.get(input.id))?.active).toBe(false)
  })
  it("classifies malformed endpoint URLs as expected connection rejections", () => {
    expect(() => connectionUrl("not a url")).toThrow(ConnectionError)
  })
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
    expect(first.name).toBe("mcp_a4aba317c556a85e87ba0e551b86d28f1e09d64f")
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
    expect(
      await Effect.runPromise(
        connections.disconnect(input.id, 1).pipe(Effect.result)
      )
    ).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConnectionTransportError" },
    })
    expect(Effect.runSync(store.get(input.id))?.active).toBe(false)
    expect(Effect.runSync(store.get(input.id))?.revision).toBe(2)
    expect(() => Effect.runSync(store.change(input.id, 1, true))).toThrow(
      "changed"
    )
    Effect.runSync(store.change(input.id, 2, true))
    mcp.removeServer.mockClear()
    await Effect.runPromise(
      connections.reconnect(input.id, 2, "https://app.example.com")
    )
    expect(mcp.removeServer).not.toHaveBeenCalled()
    expect(Effect.runSync(store.get(input.id))?.revision).toBe(3)
  })
  it("uses authoritative remote names and refuses old tool identities after reconnect", async () => {
    const { connections, calls, store } = fixture()
    const tool = (await Effect.runPromise(connections.list()))[0]!.tools[0]!
    expect(
      (
        await Effect.runPromise(
          connections.call(tool.name, { value: "Synthetic" })
        )
      ).isError
    ).not.toBe(true)
    expect(calls).toEqual([
      {
        serverId: input.id,
        name: `${input.id}.read`,
        arguments: { value: "Synthetic" },
      },
    ])
    Effect.runSync(store.change(input.id, 1, true))
    expect(
      (await Effect.runPromise(connections.call(tool.name, {}))).isError
    ).toBe(true)
    expect(calls).toHaveLength(1)
  })
  it("rechecks revocation after waiting for a connection and never dispatches a revoked call", async () => {
    const { store, mcp, connections, calls } = fixture()
    const tool = (await Effect.runPromise(connections.list()))[0]!.tools[0]!
    mcp.waitForConnections = async () => {
      Effect.runSync(store.change(input.id, 1, false))
    }
    expect(
      (await Effect.runPromise(connections.call(tool.name, {}))).isError
    ).toBe(true)
    expect(calls).toHaveLength(0)
  })
  it("preserves structured-only results as bounded model content", async () => {
    const { mcp, connections } = fixture()
    const tool = (await Effect.runPromise(connections.list()))[0]!.tools[0]!
    Object.assign(mcp, {
      callTool: async () => ({
        content: [],
        structuredContent: { answer: "Synthetic result" },
        _meta: { secret: "private-provider-secret" },
      }),
    })
    expect(await Effect.runPromise(connections.call(tool.name, {}))).toEqual({
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
    expect(
      (await Effect.runPromise(connections.list()))[0]?.tools
    ).toHaveLength(1)
    const tool = (await Effect.runPromise(connections.list()))[0]!.tools[0]!
    mcp.callTool = async () => {
      throw new Error("private-provider-secret")
    }
    expect(
      JSON.stringify(await Effect.runPromise(connections.call(tool.name, {})))
    ).not.toContain("private-provider-secret")
  })
})
describe("per-bot connected tool selection", () => {
  it("requires the selection write guard at the repository boundary", async () => {
    const store = new ConnectionStore(database())
    const tool = await remoteTool({ ...input, revision: 1 }, definition)
    await expect(
      Effect.runPromise(
        sqliteRemoteSelection(store).select(0, [tool], () =>
          Effect.sync(() => false)
        )
      )
    ).rejects.toThrow("Restore")
    expect(Effect.runSync(store.selection())).toEqual({
      revision: 0,
      tools: [],
    })
  })
  it("rolls back failed selection writes as typed storage failures", async () => {
    const db = database(),
      store = new ConnectionStore(db)
    const tool = await remoteTool({ ...input, revision: 1 }, definition)
    Effect.runSync(store.select(0, [tool]))
    db.run(
      "CREATE TRIGGER reject_selection BEFORE UPDATE ON bot_remote_tools BEGIN SELECT RAISE(ABORT,'selection failure'); END"
    )
    const result = await Effect.runPromise(
      sqliteRemoteSelection(store)
        .select(1, [], () => Effect.sync(() => true))
        .pipe(Effect.result)
    )
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ConnectionStorageError" },
    })
    expect(Effect.runSync(store.selection())).toEqual({
      revision: 1,
      tools: [tool],
    })
  })
  it("treats malformed historical selections as defects", async () => {
    const db = database(),
      store = new ConnectionStore(db)
    db.run(
      "INSERT INTO bot_remote_tools VALUES (1,1,?)",
      JSON.stringify([{ name: "missing identity and schema" }])
    )
    const exit = await Effect.runPromise(
      Effect.exit(sqliteRemoteSelection(store).selection())
    )
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(false)
  })
  it("retains pinned offline tools while removing another and rejects stale replacement", async () => {
    const first = new ConnectionStore(database()),
      second = new ConnectionStore(database())
    const a = await remoteTool({ ...input, revision: 1 }, definition)
    const b = await remoteTool(
      { ...input, revision: 1 },
      { ...definition, name: "other" }
    )
    Effect.runSync(first.select(0, [a, b]))
    const resolve = vi.fn(async () => ({ tools: [], error: "Offline" }))
    const saved = await Effect.runPromise(
      selectRemoteTools(
        sqliteRemoteSelection(first),
        { expectedRevision: 1, names: [a.name] },
        () => Effect.promise(resolve),
        () => Effect.sync(() => true)
      )
    )
    expect(saved.tools).toEqual([a])
    expect(resolve).not.toHaveBeenCalled()
    expect(Effect.runSync(second.selection()).tools).toEqual([])
    await expect(
      Effect.runPromise(
        selectRemoteTools(
          sqliteRemoteSelection(first),
          { expectedRevision: 1, names: [] },
          () => Effect.promise(resolve),
          () => Effect.sync(() => true)
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
          sqliteRemoteSelection(first),
          { expectedRevision: 0, names: [tool.name] },
          () =>
            Effect.sync(() => {
              writable = false
              return { tools: [tool], error: null }
            }),
          () => Effect.sync(() => writable)
        )
      )
    ).rejects.toThrow("Restore")
    expect(Effect.runSync(first.selection()).tools).toEqual([])
    Effect.runSync(first.select(0, [tool]))
    const access = new AccessStore(database(), () =>
      Effect.sync(() =>
        Effect.runSync(first.selection()).tools.map((value) => ({
          name: value.name,
          description: value.description,
          mode: "ask",
        }))
      )
    )
    const id = crypto.randomUUID()
    expect(
      Effect.runSync(
        access.begin({ id, turnId: "turn", tool: tool.name, input: "{}" })
      ).status
    ).toBe("pending")
    Effect.runSync(access.update(tool.name, 0, "allow"))
    Effect.runSync(access.revoke(tool.name))
    expect(Effect.runSync(access.get(id))?.status).toBe("denied")
    expect(Effect.runSync(access.policy(tool.name)).mode).toBe("ask")
    expect(Effect.runSync(access.policy(tool.name)).revision).toBe(2)
  })
})
