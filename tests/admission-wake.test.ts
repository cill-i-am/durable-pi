import { makeSummaryModel } from "../src/memory/summary-execution"
import {
  SummaryRouting,
  summaryRoutingApplication,
} from "../src/memory/routing"
import { summaryInput } from "../src/memory/adapters/summary-input"
import { summaryRetryAuthority } from "../src/memory/adapters/retry-authority"
import { expect, it, vi } from "vitest"
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect"
import {
  Conversations,
  conversationApplication,
} from "../src/conversations/service"
import { PersonalAgent } from "../src/agent/worker"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { workspaceLayer } from "../src/workspace/adapters/storage"
import { catalog, credential, response } from "./inference-fixture"
import { accountCredentials } from "../src/inference/adapters/credentials-pi"
import { usageFixture } from "./usage-fixture"
import { piModelStreamsLayer } from "../src/inference/adapters/streams-pi"
import { createRegistry } from "@earendil-works/pi-durable"
import { database } from "./database"
import { sqliteMemoryLayer } from "../src/memory/adapters/sqlite"
import { MemoryRepository } from "../src/memory/repository"
import { MemoryTransaction, type MemoryLedger } from "../src/memory/ledger"
import { memorySummaryRetry } from "../src/memory/retry"
import type { Sqlite } from "../src/storage/sqlite"
import { SummaryRoutes } from "../src/memory/adapters/model-routes"
import { SqliteBackgroundMailbox } from "../src/delegation/adapters/background-mailbox"
import { makeBackgroundMailbox } from "../src/delegation/background-mailbox"
import { makeBackgroundDelegation } from "../src/delegation/background-service"
import { resolveRoute } from "../src/inference/policy"
import { conversationPump } from "../src/conversations/pump"
import { conversationFixture } from "./conversation-fixture"
import { BotConfigurationStore } from "../src/agents/adapters/configuration"
import { SkillStore } from "../src/skills/adapters/sqlite"
import { Workspace } from "../src/workspace/workspace"
import { WorkspaceAdmission } from "../src/workspace/admission"
import {
  guardedMessageAdmission,
  messageAdmission,
} from "../src/conversations/admission"
import { conversationTransactions } from "../src/conversations/adapters/sqlite-journal"
import { conversationNativeOperation } from "../src/conversations/adapters/pi-execution"
import { homeAgentId } from "../src/agents/domain"

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
  env: {},
  tracing: undefined,
}))
vi.mock("agents/lifecycle", () => ({
  Lifecycle: class {},
  LifecycleCapability: class {},
}))
vi.mock("agents/harness/pi", () => ({ PiHarness: class {} }))

class PersonalAgentTest extends PersonalAgent {
  summaryProviderForTest() {
    return this.createSummaryProvider()
  }
}
function wireSummaryModel(host: PersonalAgentTest, routes: SummaryRoutes) {
  const inputs = {
    settings: () => summaryInput(host.conversationService.jobSetting("memory")),
    catalog: () =>
      summaryInput(
        conversationNativeOperation("read summary catalog", () =>
          host.accountModelCatalog()
        )
      ),
  }
  const routing = Effect.runSync(
    SummaryRouting.pipe(Effect.provide(summaryRoutingApplication(routes)))
  )
  Object.assign(host, { summaryInputs: inputs })
  Object.assign(host, {
    summaryModel: makeSummaryModel(
      routing,
      inputs,
      host.summaryProviderForTest()
    ),
  })
}
function fixture() {
  const db = database(),
    conversations = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      piModelStreamsLayer,
      workspaceLayer(
        db,
        { get: async () => null, put: async () => {} },
        "test"
      ),
      conversationApplication(conversations)
    )
  )
  const wakes: (string | null)[] = []
  const botConfiguration = new BotConfigurationStore(db)
  const skills = new SkillStore(db)
  const host: PersonalAgentTest = Object.create(PersonalAgentTest.prototype)
  Object.assign(host, {
    conversations,
    actorRuntime: runtime,
    ctx: { waitUntil: vi.fn() },
    conversationService: runtime.runSync(Conversations),

    botConfiguration,
    skills,
    notifyConversation: () => {},
    modelConnected: async () => true,
    accountModelCatalog: async () => catalog,
    runner: {
      wake: async () => {
        wakes.push(conversations.active()?.id ?? null)
      },
    },
  })
  Object.assign(host, {
    messageAdmission: messageAdmission(
      runtime.runSync(Conversations),
      runtime.runSync(Workspace),
      guardedMessageAdmission(
        conversations,
        botConfiguration,
        runtime.runSync(WorkspaceAdmission),
        skills,
        conversationTransactions(db)
      ),
      {
        connected: () =>
          conversationNativeOperation("read model connection", () =>
            host.modelConnected()
          ),
        archived: () =>
          Effect.sync(() => botConfiguration.read()?.status === "archived"),
        catalog: () =>
          conversationNativeOperation("read model catalog", () =>
            host.accountModelCatalog()
          ),
        wake: () =>
          conversationNativeOperation("wake conversation", () =>
            host.runner.wake()
          ),
        notify: () => Effect.sync(() => host.notifyConversation()),
      }
    ),
  })
  return { host, conversations, runtime, wakes, db }
}

const summaryMemory = (db: Sqlite) =>
  Effect.runSync(
    Effect.gen(function* () {
      return {
        memory: yield* MemoryRepository,
        ledger: yield* MemoryTransaction,
      }
    }).pipe(Effect.provide(sqliteMemoryLayer(db)))
  )
function wireSummaryRetry(
  host: PersonalAgent,
  db: Sqlite,
  ledger: MemoryLedger,
  routes: SummaryRoutes
) {
  const configuration = new BotConfigurationStore(db)
  Object.assign(host, {
    botConfiguration: configuration,
    retrySummary: memorySummaryRetry(
      ledger,
      summaryRetryAuthority(configuration),
      routes,
      host.conversationService,
      {
        catalog: () =>
          conversationNativeOperation("read summary model catalog", () =>
            host.accountModelCatalog()
          ),
        wake: () =>
          conversationNativeOperation("wake memory compaction", () =>
            host.compactor.wake()
          ),
        notify: () => Effect.sync(() => host.notifyConversation()),
      }
    ),
  })
}
it("bounds request projections by the active model and durable routing pin, including a smaller concurrent runtime budget", () => {
  const host: PersonalAgentTest = Object.create(PersonalAgentTest.prototype)
  let pin = 272000,
    window = 272000,
    floor: number | undefined
  Object.assign(host, {
    active: () => ({ model: "selected", routing: { contextWindow: pin } }),
    models: { getModel: () => ({ contextWindow: window }) },
    communicationFloor: () => floor,
  })
  expect(host.contextProjectionBytes()).toBe(8192)
  window = 1050000
  pin = 32000
  expect(host.contextProjectionBytes()).toBe(1000)
  floor = 8192
  expect(host.contextProjectionBytes()).toBe(256)
  floor = undefined
  window = 16000
  expect(host.contextProjectionBytes()).toBe(500)
})
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
    await expect(host.acceptMessage(input)).rejects.toMatchObject({
      _tag: "ConversationExecutionError",
      operation: "wake conversation",
    })
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
    const now = new Date().toISOString()
    host.botConfiguration.configure("owner", {
      id: homeAgentId,
      name: "Test",
      instructions: "",
      status: "archived",
      revision: 1,
      createdAt: now,
      updatedAt: now,
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
    { memory, ledger } = summaryMemory(db),
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
    lifecycle: { start: async () => {} },
    compactor: {
      wake: async () => {
        if (++wakes === 1) throw new Error("Wake acknowledgement lost")
      },
    },
  })
  wireSummaryRetry(host, db, ledger, summaryRoutes)
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
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  Object.assign(host, { summaryRoutes: routes })
  host.accountModelCatalog = async () => {
    entered()
    await waiting
    return catalog
  }
  wireSummaryModel(host, routes)
  try {
    const pending = runtime.runPromiseExit(
      host.summaryModel.complete([], job),
      { signal: controller.signal }
    )
    await started
    controller.abort()
    routes.replace(
      job,
      crypto.randomUUID(),
      resolveRoute("memory", { model: "gpt-6.1-sol", thinking: "medium" })
    )
    release()
    const exit = await pending
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
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
    { memory, ledger } = summaryMemory(db),
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
    lifecycle: { start: async () => {} },
    compactor: { wake: async () => {} },
  })
  wireSummaryRetry(host, db, ledger, summaryRoutes)
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
    if (++lookups === 1) await started
    else if (lookups === 2) {
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
    inferenceUsage = usageFixture(db),
    payloads: Record<string, unknown>[] = []
  Object.assign(host, {
    db,
    summaryRoutes,
    inferenceUsage: inferenceUsage.service,
    observeInference: inferenceUsage.start,
    ctx: { id: { toString: () => "synthetic-bot" }, waitUntil: vi.fn() },
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
    wireSummaryModel(host, summaryRoutes)
    await runtime.runPromise(
      host.summaryModel.complete(
        [
          {
            role: "user",
            text: "Compress the synthetic source.",
          },
        ],
        job
      )
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
  const mailbox = makeBackgroundMailbox(
    new SqliteBackgroundMailbox(db),
    () => (parentDone ? "done" : "active"),
    "synthetic-parent",
    () => crypto.randomUUID()
  )
  const handoff = Effect.runSync(
    mailbox.create(
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
      }
    )
  ).handoff
  parentDone = true
  Effect.runSync(
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
  )
  const f = await Effect.runPromise(conversationFixture(db))
  f.memory.settled = () => Effect.succeed(false)
  f.memory.blocked = () => Effect.succeed(true)
  f.host.wakeBackground = () => Effect.promise(() => host.stepBackground())
  f.host.notify = () => Effect.sync(() => host.notifyConversation())
  Object.assign(host, {
    backgroundMailbox: mailbox,
    background: makeBackgroundDelegation(
      mailbox,
      {
        start: () => Effect.die("Unexpected remote start"),
        read: () => Effect.die("Unexpected remote read"),
        stop: () => Effect.void,
        control: () => Effect.die("Unexpected control"),
        transcript: () => Effect.die("Unexpected transcript"),
      },
      {
        active: () => Effect.sync(() => !!conversations.active()),
        backgroundActive: () =>
          Effect.sync(() => !!conversations.active()?.origin),
        wakeConversation: () => Effect.promise(() => host.runner.wake()),
        wakeBackground: () => Effect.void,
        notify: () => Effect.sync(() => host.notifyConversation()),
        admission: {
          transactionGroup: db,
          stop: () => {},
          admit: (h, report) =>
            conversations.admit(
              {
                operationId: h.reportId,
                text: report,
                origin: { kind: "background", groupId: h.id, turnId: h.turnId },
              },
              undefined,
              [],
              h.route
            ).turn.id,
        },
      }
    ),
    backgroundRunner: { wake: () => host.stepBackground() },
    routineAuthority: { canRun: () => true },
    conversationPump: conversationPump(
      host.conversationService,
      f.memory,
      f.journal,
      f.execution,
      f.host
    ),
  })
  try {
    await host.stepBackground()
    expect(Effect.runSync(mailbox.get(73))?.status).toBe("ready")
    expect(Effect.runSync(mailbox.nextWake())).toBeUndefined()
    await host.step()
    expect(conversations.get(foreground.id)?.status).toBe("failed")
    expect(Effect.runSync(mailbox.get(73))?.status).toBe("delivered")
    expect(conversations.active()?.origin).toMatchObject({
      kind: "background",
      groupId: 73,
    })
    expect(wakes).toContain(handoff.reportId)
    await host.stepBackground()
    expect(conversations.recent().filter((turn) => turn.origin)).toHaveLength(1)
  } finally {
    await runtime.dispose()
  }
})
