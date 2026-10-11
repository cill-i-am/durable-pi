import { expect, it, vi } from "vitest"
import { ManagedRuntime } from "effect"
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
import { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { catalog } from "./inference-fixture"
import { database } from "./database"

function fixture() {
  const db = database(),
    conversations = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
  const runtime = ManagedRuntime.make(
    workspaceLayer(db, { get: async () => null, put: async () => {} }, "test")
  )
  const wakes: (string | null)[] = []
  const host: PersonalAgent = Object.create(PersonalAgent.prototype)
  Object.assign(host, {
    conversations,
    workspaceRuntime: runtime,
    botConfiguration: { read: () => ({ status: "active" }) },
    skills: { selection: () => ({ skills: [] }) },
    notifyConversation: () => {},
    modelConnected: async () => true,
    accountModelCatalog: async () => catalog,
    runner: {
      wake: async () => {
        wakes.push(conversations.active()?.id ?? null)
      },
    },
  })
  return { host, conversations, runtime, wakes }
}
it("arms the run after asynchronous discovery and durable admission; replay re-arms without duplicating the turn", async () => {
  const { host, conversations, runtime, wakes } = fixture()
  let started!: () => void, release!: () => void
  const discoveryStarted = new Promise<void>((resolve) => (started = resolve)),
    waiting = new Promise<void>((resolve) => (release = resolve))
  host.accountModelCatalog = async () => {
    started()
    await waiting
    return catalog
  }
  const input = { operationId: crypto.randomUUID(), text: "A simple reply" }
  try {
    const request = host.acceptMessage(input)
    await discoveryStarted
    expect(conversations.active()).toBeUndefined()
    expect(wakes).toEqual([])
    release()
    expect((await request).status).toBe(202)
    expect(wakes).toEqual([input.operationId])
    const replay = await host.acceptMessage(input)
    expect(await replay.json()).toMatchObject({
      accepted: false,
      operationId: input.operationId,
    })
    expect(wakes).toEqual([input.operationId, input.operationId])
    expect(conversations.recent()).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})
it("recovers a failed alarm acknowledgement on a submission retry without repeating admission", async () => {
  const { host, conversations, runtime } = fixture(),
    input = {
      operationId: crypto.randomUUID(),
      text: "Persist before scheduling",
    }
  let calls = 0
  host.runner.wake = async () => {
    if (++calls === 1) throw new Error("Synthetic alarm failure")
  }
  try {
    await expect(host.acceptMessage(input)).rejects.toThrow(
      "Synthetic alarm failure"
    )
    expect(conversations.get(input.operationId)?.status).toBe("queued")
    expect(await (await host.acceptMessage(input)).json()).toMatchObject({
      accepted: false,
    })
    expect(calls).toBe(2)
    expect(conversations.recent()).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})
it("does not admit or wake new work when the bot is archived during catalog discovery", async () => {
  const { host, conversations, runtime, wakes } = fixture()
  host.accountModelCatalog = async () => {
    Object.assign(host, {
      botConfiguration: { read: () => ({ status: "archived" }) },
    })
    return catalog
  }
  try {
    expect(
      (
        await host.acceptMessage({
          operationId: crypto.randomUUID(),
          text: "Do not start",
        })
      ).status
    ).toBe(409)
    expect(conversations.recent()).toEqual([])
    expect(wakes).toEqual([])
  } finally {
    await runtime.dispose()
  }
})
