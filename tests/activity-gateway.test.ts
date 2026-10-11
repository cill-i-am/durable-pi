import { expect, it, vi } from "vitest"
import service from "../src/agent/worker"
import type { AgentEnv } from "../alchemy.run"
import { agentObjectName, AgentId } from "../src/agents/domain"
import { Schema } from "effect"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  env: {},
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))

const first = {
  id: Schema.decodeUnknownSync(AgentId)("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  name: "First bot",
}
const second = {
  id: Schema.decodeUnknownSync(AgentId)("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  name: "Second bot",
}
function fixture() {
  const names: string[] = []
  const read = vi.fn(async () => ({ entries: [], issues: [] }))
  const root = (agent: typeof first) => ({
    activityAgents: async () => [agent],
    agentProfile: async (id: string) => (id === agent.id ? agent : null),
    modelConnected: async () => true,
  })
  // Only the binding surface exercised by the production gateway is replaced.
  const env = {
    AGENT: {
      getByName: (name: string) => {
        names.push(name)
        if (name === "owner-a") return root(first)
        if (name === "owner-b") return root(second)
        if (
          [
            agentObjectName("owner-a", first.id),
            agentObjectName("owner-b", second.id),
          ].includes(name)
        )
          return { readActivity: read, activityConversation: async () => null }
        throw new Error("Unowned object addressed")
      },
    },
  } as unknown as AgentEnv
  const request = (path: string, owner?: string, method = "GET") =>
    service.fetch(
      new Request(`https://internal/api/agent/${path}`, {
        method,
        headers: owner ? { "x-owner-id": owner } : {},
      }),
      env
    )
  return { request, names, read }
}
it("derives global fanout from the authenticated owner's catalog, ignoring arbitrary owner parameters", async () => {
  const f = fixture()
  expect(
    (
      await f.request(
        `activity?scope=all&owner=owner-b&agent=${second.id}`,
        "owner-a"
      )
    ).status
  ).toBe(200)
  expect(f.names).toEqual(["owner-a", agentObjectName("owner-a", first.id)])
  expect(f.read).toHaveBeenCalledOnce()
  expect(f.read.mock.calls[0]).toEqual([first, { filter: "all", cursor: null }])
})
it("refuses unowned bot and saved-conversation references without contacting their object", async () => {
  const f = fixture()
  expect(
    (await f.request(`activity?agent=${second.id}`, "owner-a")).status
  ).toBe(404)
  expect(
    (
      await f.request(
        `activity/conversations/${crypto.randomUUID()}?agent=${second.id}`,
        "owner-a"
      )
    ).status
  ).toBe(404)
  expect(f.names).toEqual(["owner-a", "owner-a"])
  expect(f.read).not.toHaveBeenCalled()
})
it("requires authentication and read methods, and reports unknown conversation IDs as missing", async () => {
  const f = fixture()
  expect((await f.request("activity?scope=all")).status).toBe(401)
  expect(
    (await f.request("activity?scope=all", "owner-a", "POST")).status
  ).toBe(405)
  expect(
    (
      await f.request(
        `activity/conversations/${crypto.randomUUID()}?agent=${first.id}`,
        "owner-a"
      )
    ).status
  ).toBe(404)
  expect(f.read).not.toHaveBeenCalled()
})

it("keeps ordinary chat available when a new gateway reaches a previous-version Durable Object", async () => {
  const configureBot = vi.fn(
    async (_owner: string, _profile: typeof first) => {}
  )
  const fetch = vi.fn(async () => Response.json({ turns: [] }))
  const previousVersion = { configureBot, fetch }
  const env = {
    AGENT: {
      getByName: (name: string) =>
        name === "owner-a"
          ? { agentProfile: async () => first }
          : previousVersion,
    },
  } as unknown as AgentEnv
  const result = await service.fetch(
    new Request(`https://internal/api/agent/state?agent=${first.id}`, {
      headers: { "x-owner-id": "owner-a" },
    }),
    env
  )
  expect(result.status).toBe(200)
  expect(fetch).toHaveBeenCalledOnce()
  // The previous version ignores the additive third argument. The current
  // version validates it against the actual DO ID before persisting identity.
  expect(configureBot.mock.calls[0]).toEqual(["owner-a", first, "owner-a"])
  expect("bindCommunicationIdentity" in previousVersion).toBe(false)
})
