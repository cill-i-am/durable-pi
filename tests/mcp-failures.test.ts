import { Cause, Effect, Exit } from "effect"
import { expect, it, vi } from "vitest"

import {
  mcpConnectionClient,
  type McpManager,
} from "../src/access/adapters/mcp"
import { ConnectionTransportError } from "../src/access/connections"

function fixture() {
  const manager: McpManager = {
    listServers: vi.fn(() => []),
    mcpConnections: {},
    listTools: () => [],
    registerServer: vi.fn<McpManager["registerServer"]>(),
    connectToServer: vi.fn<McpManager["connectToServer"]>(),
    discoverIfConnected: vi.fn<McpManager["discoverIfConnected"]>(),
    removeServer: vi.fn<McpManager["removeServer"]>(),
    isCallbackRequest: vi.fn<McpManager["isCallbackRequest"]>(),
    handleCallbackRequest: vi.fn<McpManager["handleCallbackRequest"]>(),
    establishConnection: vi.fn<McpManager["establishConnection"]>(),
    waitForConnections: vi.fn<McpManager["waitForConnections"]>(),
    callTool: async () => ({ content: [] }),
  }
  return { manager, client: mcpConnectionClient(manager) }
}

it.each(["read", "async"])(
  "MCP %s preserves a complete local Cause",
  async (mode) => {
    const f = fixture()
    const defect = new Error("private MCP defect")
    const cause = Cause.fromReasons([
      Cause.makeFailReason(
        new ConnectionTransportError({ operation: "probe", cause: "private" })
      ),
      Cause.makeDieReason(defect),
      Cause.makeInterruptReason(),
    ])
    vi.mocked(f.manager.listServers).mockImplementation(() => {
      throw cause
    })
    vi.mocked(f.manager.removeServer).mockRejectedValue(cause)
    const exit = await Effect.runPromiseExit(
      mode === "read" ? f.client.inspect("id") : f.client.remove("id")
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(exit.cause.reasons.map((reason) => reason._tag)).toEqual([
        "Fail",
        "Die",
        "Interrupt",
      ])
      expect(exit.cause.reasons).toContainEqual(
        expect.objectContaining({ _tag: "Die", defect })
      )
    }
  }
)
it("MCP joins late defects and its instance settlement owner", async () => {
  const f = fixture()
  let entered!: () => void, reject!: (cause: unknown) => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  vi.mocked(f.manager.removeServer).mockImplementation(() => {
    entered()
    return pending
  })
  const controller = new AbortController()
  let completed = false,
    disposed = false
  const work = Effect.runPromiseExit(f.client.remove("id"), {
    signal: controller.signal,
  }).then((exit) => {
    completed = true
    return exit
  })
  await started
  controller.abort()
  const closing = Effect.runPromise(f.client.settle()).then(() => {
    disposed = true
  })
  await Promise.resolve()
  expect(completed).toBe(false)
  expect(disposed).toBe(false)
  const defect = new Error("private late MCP defect")
  reject(Cause.die(defect))
  const exit = await work
  await closing
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    expect(Cause.hasInterrupts(exit.cause)).toBe(true)
    expect(exit.cause.reasons).toContainEqual(
      expect.objectContaining({ _tag: "Die", defect })
    )
  }
})
it("MCP keeps synchronous async-method bugs fatal", async () => {
  const f = fixture(),
    defect = new Error("MCP startup bug")
  vi.mocked(f.manager.removeServer).mockImplementation(() => {
    throw defect
  })
  const exit = await Effect.runPromiseExit(f.client.remove("id"))
  expect(Exit.isFailure(exit) && exit.cause.reasons).toMatchObject([
    { _tag: "Die", defect },
  ])
})
