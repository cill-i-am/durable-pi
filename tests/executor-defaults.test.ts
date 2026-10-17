import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { AccessStore } from "../src/access/adapters/sqlite"
import {
  connectionUrl,
  type ConnectionInfo,
  type RemoteTool,
} from "../src/access/connections"
import {
  connectedToolPolicies,
  connectedTools,
  executorDefaultTools,
  executorUrl,
} from "../src/access/executor"
import { database } from "./database"

const tool: RemoteTool = {
  name: `mcp_${"a".repeat(40)}`,
  connectionId: `mcp-${"b".repeat(32)}`,
  connectionRevision: 1,
  connectionName: "Executor",
  remoteName: "search",
  description: "Find tools",
  parameters: { type: "object" },
}
const connection: ConnectionInfo = {
  id: tool.connectionId,
  name: "Executor",
  url: executorUrl,
  revision: 1,
  active: true,
  status: "ready",
  authorizeUrl: null,
  tools: [tool],
}
describe("workspace Executor defaults", () => {
  it("only permits the exact hosted browser-approval endpoint's query", () => {
    expect(connectionUrl(executorUrl)).toBe(executorUrl)
    for (const url of [
      "https://other.example.com/mcp?elicitation_mode=browser",
      "https://mcp.executor.sh/mcp?elicitation_mode=model",
      `${executorUrl}&token=synthetic`,
      "https://mcp.executor.sh/mcp?elicitation_mode=browser&elicitation_mode=native",
      "https://mcp.executor.sh.evil.example.com/mcp?elicitation_mode=browser",
      "https://user:password@mcp.executor.sh/mcp?elicitation_mode=browser",
    ])
      expect(() => connectionUrl(url)).toThrow()
  })
  it("does not trust a connection label, inactive grant, or a different approval mode", () => {
    expect(executorDefaultTools([connection])).toEqual([tool])
    for (const change of [
      { url: "https://other.example.com/mcp" },
      { url: "https://mcp.executor.sh/mcp" },
      { active: false },
      { status: "authorization" as const },
      { status: "unavailable" as const },
    ])
      expect(executorDefaultTools([{ ...connection, ...change }])).toEqual([])
  })
  it("only inherits the six documented entry points and preserves explicit selections", () => {
    const other = {
      ...tool,
      name: `mcp_${"c".repeat(40)}`,
      remoteName: "new_unsafe_tool",
    }
    expect(
      executorDefaultTools([{ ...connection, tools: [tool, other] }])
    ).toEqual([tool])
    expect(connectedTools([tool, other], [tool])).toEqual([tool, other])
    expect(
      connectedToolPolicies([other], [tool]).map((value) => value.mode)
    ).toEqual(["allow", "ask"])
  })
  it("retains per-agent deny/ask settings and durable dispatch uncertainty", () => {
    const db = database()
    const store = new AccessStore(db, () =>
      Effect.succeed(connectedToolPolicies([], [tool]))
    )
    const intent = {
      id: crypto.randomUUID(),
      turnId: crypto.randomUUID(),
      tool: tool.name,
      input: "{}",
    }
    expect(Effect.runSync(store.begin(intent)).status).toBe("approved")
    expect(Effect.runSync(store.claim(intent.id))).toBe("execute")
    expect(() => Effect.runSync(store.claim(intent.id))).toThrow(
      "outcome is unknown"
    )
    Effect.runSync(store.update(tool.name, 0, "deny"))
    expect(() =>
      Effect.runSync(store.begin({ ...intent, id: crypto.randomUUID() }))
    ).toThrow()
    Effect.runSync(store.update(tool.name, 1, "ask"))
    const restarted = new AccessStore(db, () =>
      Effect.succeed(connectedToolPolicies([], [tool]))
    )
    expect(
      Effect.runSync(restarted.begin({ ...intent, id: crypto.randomUUID() }))
        .status
    ).toBe("pending")
  })
})
