import { expect, it, vi } from "vitest"
import { Effect, ManagedRuntime } from "effect"
import { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { catalog, credential, response } from "./inference-fixture"
import { accountCredentials } from "../src/agent/models"
import { InferenceUsage } from "../src/inference/usage"
import { createRegistry } from "@earendil-works/pi-durable"
import { database } from "./database"
import { makeSqliteMemory } from "../src/memory/adapters/sqlite"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { BackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { resolveRoute } from "../src/inference/policy"

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
  return { host, conversations, runtime, wakes, db }
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

it("repairs a failed summary retry wake on exact replay, without another route revision", async () => {
  const { host, runtime } = fixture(),
    db = database(),
    memory = Effect.runSync(makeSqliteMemory(db)),
    summaryRoutes = new SummaryRoutes(db),
    part = { start: 0, count: 1 },
    operationId = crypto.randomUUID()
  Effect.runSync(memory.append("failed", "user", "Original source"))
  summaryRoutes.pin(part, resolveRoute("memory"))
  for (let attempt = 0; attempt < 3; attempt++)
    Effect.runSync(memory.failNode(part, 10000))
  let wakes = 0
  Object.defineProperty(host, "memory", { value: memory })
  Object.assign(host, {
    db,
    summaryRoutes,
    memoryRuntime: { runSync: Effect.runSync },
    lifecycle: { start: async () => {} },
    compactor: {
      wake: async () => {
        if (++wakes === 1) throw new Error("Wake acknowledgement lost")
      },
    },
  })
  const request = () =>
    new Request("https://internal/api/agent/memory/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...part, operationId }),
    })
  try {
    expect((await host.fetch(request())).ok).toBe(false)
    expect(Effect.runSync(memory.issues())).toEqual([])
    expect(db.all("SELECT * FROM summary_routes")).toHaveLength(2)
    expect(await (await host.fetch(request())).json()).toEqual({ ok: true })
    expect(wakes).toBe(2)
    expect(db.all("SELECT * FROM summary_routes")).toHaveLength(2)
    expect(Effect.runSync(memory.entry(0))?.text).toBe("Original source")
  } finally {
    await runtime.dispose()
  }
})

it("does not debit a replacement summary route when obsolete discovery returns after cancellation", async () => {
  const { host, runtime } = fixture(),
    db = database(),
    routes = new SummaryRoutes(db),
    job = { start: 0, count: 1, source: "Synthetic source", context: "" },
    controller = new AbortController()
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  Object.assign(host, { summaryRoutes: routes })
  host.accountModelCatalog = async () => {
    await waiting
    return catalog
  }
  try {
    const pending = host.completeMemorySummary([], controller.signal, job)
    controller.abort()
    routes.replace(
      job,
      crypto.randomUUID(),
      resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "medium" })
    )
    release()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    expect(
      db
        .all<{ requests: number }>("SELECT requests FROM summary_routes")
        .map((row) => row.requests)
    ).toEqual([0, 0])
    expect(routes.current(job)?.contextWindow).toBeUndefined()
    expect(routes.current(job)).toMatchObject({
      model: "gpt-6.1-sol",
    })
  } finally {
    await runtime.dispose()
  }
})

it("rejects a delayed retry for an older summary revision after the newer retry also pauses", async () => {
  const { host, runtime } = fixture(),
    db = database(),
    memory = Effect.runSync(makeSqliteMemory(db)),
    summaryRoutes = new SummaryRoutes(db),
    part = { start: 0, count: 1 }
  Effect.runSync(memory.append("failed", "user", "Original source"))
  summaryRoutes.pin(part, resolveRoute("memory"))
  const pause = () => {
    for (let n = 0; n < 3; n++) Effect.runSync(memory.failNode(part, 10000))
  }
  pause()
  Object.defineProperty(host, "memory", { value: memory })
  Object.assign(host, {
    db,
    summaryRoutes,
    memoryRuntime: { runSync: Effect.runSync },
    lifecycle: { start: async () => {} },
    compactor: { wake: async () => {} },
  })
  let lookups = 0,
    release!: () => void,
    entered!: () => void
  const waiting = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve
    })
  host.accountModelCatalog = async () => {
    if (++lookups === 2) {
      entered()
      await waiting
    }
    return catalog
  }
  const request = () =>
    new Request("https://internal/api/agent/memory/retry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...part, operationId: crypto.randomUUID() }),
    })
  try {
    const a = host.fetch(request()),
      b = host.fetch(request())
    await started
    expect((await a).ok).toBe(true)
    pause()
    release()
    expect((await b).ok).toBe(false)
    expect(summaryRoutes.revision(part)).toBe(2)
    expect(Effect.runSync(memory.paused(part))).toBe(true)
  } finally {
    await runtime.dispose()
  }
})

it("sends the pinned independent memory model through the installed Responses adapter and records real-shaped usage", async () => {
  const { host, runtime, conversations } = fixture(),
    db = database(),
    summaryRoutes = new SummaryRoutes(db),
    job = { start: 0, count: 1, source: "Synthetic original", context: "" },
    inferenceUsage = new InferenceUsage(db),
    payloads: Record<string, unknown>[] = []
  db.run(
    "CREATE TABLE model_usage (id TEXT PRIMARY KEY, model TEXT, input INTEGER, cached INTEGER, output INTEGER, date TEXT)"
  )
  Object.assign(host, {
    db,
    summaryRoutes,
    inferenceUsage,
    ctx: { id: { toString: () => "synthetic-bot" } },
    credentials: accountCredentials(async () => credential),
    registry: createRegistry(),
  })
  vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
    const payload = JSON.parse(String(init.body))
    payloads.push(payload)
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer synthetic-local-access"
    )
    return response(payload.model)
  })
  try {
    conversations.setSettings({ model: "gpt-6-astra", thinking: "high" })
    await host.completeMemorySummary(
      [
        {
          role: "user",
          content: "Compress the synthetic source.",
          timestamp: 0,
        },
      ],
      new AbortController().signal,
      job
    )
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "medium" },
      store: false,
    })
    expect(new SummaryRoutes(db).current(job)).toMatchObject({
      model: "gpt-6-luna",
      thinking: "medium",
      contextWindow: 272000,
    })
    expect(inferenceUsage.recent()[0]).toMatchObject({
      purpose: "memory 0+1",
      outcome: "completed",
      reportedModel: "gpt-6-luna",
      input: 123,
      cached: 100,
      output: 17,
    })
    expect(db.all("SELECT * FROM model_usage")).toHaveLength(1)
  } finally {
    vi.unstubAllGlobals()
    await runtime.dispose()
  }
})

it("delivers a ready background report when a later foreground turn fails on blocked memory", async () => {
  const { host, conversations, runtime, db, wakes } = fixture()
  const source = conversations.admit({
    operationId: crypto.randomUUID(),
    text: "Draft in background",
  }).turn
  conversations.finish(
    source,
    [{ id: source.id, delivery: "answered" }],
    "Started",
    null
  )
  const foreground = conversations.admit({
    operationId: crypto.randomUUID(),
    text: "Another question",
  }).turn
  const route = { ...resolveRoute("conversation"), contextWindow: 8192 }
  let parentDone = false
  const mailbox = new BackgroundMailbox(db, () =>
    parentDone ? "done" : "active"
  )
  const handoff = mailbox.create(
    {
      objective: "Draft",
      tasks: [{ name: "Draft", task: "Draft only", tools: [] }],
    },
    {
      turnId: source.id,
      conversationId: 1,
      taskId: 73,
      route,
      memory: "",
    },
    "synthetic-parent"
  ).handoff
  parentDone = true
  mailbox.observed(73, {
    id: 73,
    turnId: source.id,
    conversationId: 1,
    objective: "Draft",
    route,
    createdAt: handoff.createdAt,
    deadline: handoff.deadline,
    status: "completed",
    children: [],
  })
  Object.defineProperty(host, "memory", {
    value: {
      settled: () => Effect.succeed(false),
      blocked: () => Effect.succeed(true),
    },
  })
  Object.assign(host, {
    backgroundMailbox: mailbox,
    backgroundRunner: { wake: () => host.stepBackground() },
    memoryRuntime: { runSync: Effect.runSync },
    routines: { canRun: () => true },
  })
  try {
    await host.stepBackground()
    expect(mailbox.get(73)?.status).toBe("ready")
    expect(mailbox.nextWake()).toBeUndefined()
    await host.step()
    expect(conversations.get(foreground.id)?.status).toBe("failed")
    expect(mailbox.get(73)?.status).toBe("delivered")
    expect(conversations.active()?.origin?.groupId).toBe(73)
    expect(wakes).toContain(handoff.reportId)
    await host.stepBackground()
    expect(conversations.recent().filter((turn) => turn.origin)).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})
