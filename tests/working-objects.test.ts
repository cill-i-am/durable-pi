import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  watchEvents,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { piWorkingObjects } from "../src/objects/adapters/pi"
import {
  objectTools,
  objectContextHook,
  recoverableObjectTools,
} from "../src/objects/adapters/tools"
import { toolReceipt } from "../src/access/adapters/receipt"
import { objectsRequest } from "../src/objects/adapters/http"
import type {
  ObjectFailure,
  ObjectMutation,
  ChangeSource,
  Checklist,
} from "../src/objects/contracts"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { builtInTools } from "../src/access/contracts"
import { database } from "./database"
import { piTimeline } from "../src/conversations/adapters/pi-timeline"

const user: ChangeSource = {
  actor: "user",
  surface: "workbench",
  turnId: null,
  toolCallId: null,
}
const execute = <T>(effect: Effect.Effect<T, ObjectFailure>) =>
  Effect.runPromise(effect)
const outcome = <T>(effect: Effect.Effect<T, ObjectFailure>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({ onSuccess: () => "ok", onFailure: (error) => error.code })
    )
  )
const create = (): ObjectMutation => ({
  id: crypto.randomUUID(),
  operationId: crypto.randomUUID(),
  expectedRevision: 0,
  action: {
    type: "create",
    title: "Website launch",
    notes: "Keep it accessible",
    tasks: [
      {
        id: crypto.randomUUID(),
        title: "Draft homepage",
        status: "pending",
        dueDate: null,
        notes: "Use actual product screens",
      },
    ],
  },
})
const edit = (id: string, revision: number, title: string): ObjectMutation => ({
  id,
  operationId: crypto.randomUUID(),
  expectedRevision: revision,
  action: { type: "update", changes: [{ type: "edit", title }] },
})

it.each(["shrink", "grow"])(
  "keeps omitted object events pending through native recovery when the request budget must %s",
  async (direction) => {
    const directory = await mkdtemp(join(tmpdir(), "object-context-")),
      path = join(directory, "pi.sqlite"),
      models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 1000000 })
    models.setProvider(faux.provider)
    let harness: Harness,
      firstProcess = true,
      budget = direction === "shrink" ? 8192 : 256
    const projections: string[] = []
    let entered!: () => void
    const requested = new Promise<void>((resolve) => {
      entered = resolve
    })
    const objects = piWorkingObjects(
        async () => harness,
        () => true
      ),
      registry = createRegistry()
    registry.install({
      name: "objects",
      hooks: [objectContextHook(objects, () => budget)],
    })
    const options = {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    }
    faux.setResponses(
      Array.from({ length: 3 }, () => async (input, options) => {
        const last = input.messages.at(-1)
        if (last?.role !== "user" || typeof last.content === "string")
          throw new Error("Missing projection")
        projections.push(
          last.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
        )
        if (firstProcess) {
          entered()
          await new Promise<void>((_, reject) => {
            const abort = () => reject(new Error("Synthetic eviction"))
            if (options?.signal?.aborted) abort()
            else
              options?.signal?.addEventListener("abort", abort, { once: true })
          })
        }
        return fauxAssistantMessage("Saved references inspected.")
      })
    )
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    try {
      const seed = create()
      if (seed.action.type !== "create") throw new Error("fixture")
      const mutation = {
        ...seed,
        action: { ...seed.action, title: "界\u0000".repeat(40) },
      }
      await execute(objects.mutate(mutation, user))
      let conversation = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      })
      const command = {
        type: "input" as const,
        requestId: crypto.randomUUID(),
        content: [
          { type: "text" as const, text: "Inspect the saved objects." },
        ],
      }
      const submission = await conversation.submit(command, ctx)
      await requested
      expect((await execute(objects.context())).offeredThrough).toBe(0)
      await harness.close(ctx)
      firstProcess = false
      budget = direction === "shrink" ? 256 : 8192
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options,
        ctx
      )
      conversation = (await harness.conversation(conversation.id, ctx))!
      const replay = await conversation.submit(command, ctx)
      expect(replay.id).toBe(submission.id)
      await replay.wait(ctx)
      await conversation.waitForIdle(ctx)
      expect(projections).toHaveLength(2)
      const omitted = projections[direction === "shrink" ? 1 : 0]!
      expect(omitted).toContain("references omitted")
      expect(new TextEncoder().encode(omitted).byteLength).toBeLessThanOrEqual(
        256
      )
      expect((await execute(objects.context())).offeredThrough).toBe(0)
      expect((await execute(objects.read(mutation.id))).events).toHaveLength(1)
      budget = 8192
      await (
        await conversation.submit(
          { ...command, requestId: crypto.randomUUID() },
          ctx
        )
      ).wait(ctx)
      await conversation.waitForIdle(ctx)
      expect(projections.at(-1)).toContain('"changed":true')
      expect((await execute(objects.context())).offeredThrough).toBe(1)
      const events = await watchEvents(harness, conversation.id, ctx)
      expect(JSON.stringify(events.snapshot.entries)).not.toContain(
        "Working objects:"
      )
      await events.stop()
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

it("atomically persists revisions, explicit conflicts, replay receipts, cancellation, isolation and paged history across native Pi restarts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "working-objects-")),
    path = join(directory, "a.sqlite")
  let writable = true
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  let objects = piWorkingObjects(
    async () => harness,
    () => writable
  )
  const other = await Harness.open(
    await openNodeSqliteStorage(join(directory, "b.sqlite")),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  try {
    const input = create(),
      receipt = await execute(objects.mutate(input, user))
    const contenders = [
      edit(input.id, 1, "First edit"),
      edit(input.id, 1, "Second edit"),
    ]
    expect(
      (
        await Promise.all(
          contenders.map((mutation) => outcome(objects.mutate(mutation, user)))
        )
      ).sort()
    ).toEqual(["conflict", "ok"])
    expect(await execute(objects.mutate(input, user))).toEqual(receipt)
    expect((await execute(objects.read(input.id))).object.revision).toBe(2)
    expect(
      await outcome(
        objects.mutate(
          {
            ...input,
            action: {
              type: "create",
              title: "Different",
              notes: "",
              tasks: [],
            },
          },
          user
        )
      )
    ).toBe("conflict")
    expect(
      await outcome(
        piWorkingObjects(
          async () => other,
          () => true
        ).read(input.id)
      )
    ).toBe("not_found")
    const cancelled = edit(input.id, 2, "Cancelled")
    await execute(objects.cancel(cancelled.operationId))
    expect(await outcome(objects.mutate(cancelled, user))).toBe("cancelled")
    const badBatch: ObjectMutation = {
      ...edit(input.id, 2, "unused"),
      action: {
        type: "update",
        changes: [
          { type: "edit", title: "Must roll back" },
          {
            type: "edit_task",
            taskId: crypto.randomUUID(),
            patch: { status: "completed" },
          },
        ],
      },
    }
    expect(await outcome(objects.mutate(badBatch, user))).toBe("not_found")
    expect((await execute(objects.read(input.id))).object.title).not.toBe(
      "Must roll back"
    )
    writable = false
    expect(
      await outcome(objects.mutate(edit(input.id, 2, "Read only"), user))
    ).toBe("read_only")
    writable = true
    for (let revision = 2; revision < 25; revision++)
      await execute(
        objects.mutate(
          edit(input.id, revision, `Revision ${revision + 1}`),
          user
        )
      )
    const first = await execute(objects.read(input.id))
    expect(first.events.map((event) => event.revision)).toEqual(
      Array.from({ length: 20 }, (_, index) => 25 - index)
    )
    const second = await execute(objects.read(input.id, first.nextHistory!))
    expect(second.events.map((event) => event.revision)).toEqual([
      5, 4, 3, 2, 1,
    ])
    expect(
      second.events.at(-1)?.changes.some((change) => change.field === "notes")
    ).toBe(true)
    const archive: ObjectMutation = {
      ...edit(input.id, 25, "unused"),
      action: {
        type: "update",
        changes: [{ type: "archive", archived: true }],
      },
    }
    await execute(objects.mutate(archive, user))
    expect(
      await outcome(
        objects.mutate(edit(input.id, 26, "Cannot edit archived"), user)
      )
    ).toBe("read_only")
    await harness.close(ctx)
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      { models: createModels(), registry: createRegistry() },
      ctx
    )
    objects = piWorkingObjects(
      async () => harness,
      () => writable
    )
    expect((await execute(objects.read(input.id))).object.archived).toBe(true)
    expect((await execute(objects.context())).sequence).toBe(26)
    expect((await execute(objects.context())).offeredThrough).toBe(0)
    await execute(
      objects.mutate(
        {
          ...archive,
          operationId: crypto.randomUUID(),
          expectedRevision: 26,
          action: {
            type: "update",
            changes: [{ type: "archive", archived: false }],
          },
        },
        user
      )
    )
    expect((await execute(objects.read(input.id))).object.tasks).toHaveLength(1)
    expect(await outcome(objects.mutate(cancelled, user))).toBe("cancelled")
    expect(await execute(objects.cancel(input.operationId))).toEqual({
      applied: true,
    })
    await execute(objects.offered(10))
    await execute(objects.offered(2))
    expect((await execute(objects.context())).offeredThrough).toBe(10)
  } finally {
    await Promise.all([harness.close(ctx), other.close(ctx)])
    await rm(directory, { recursive: true, force: true })
  }
})

it("runs typed native tools, uses the same UI operations, sees live user edits next turn, and keeps context projections out of the archive", async () => {
  const directory = await mkdtemp(join(tmpdir(), "checklist-journey-")),
    path = join(directory, "pi.sqlite")
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 })
  models.setProvider(faux.provider)
  const requests: string[] = []
  const original = models.streamSimple.bind(models)
  models.streamSimple = (model, input, options) => {
    requests.push(JSON.stringify(input.messages))
    return original(model, input, options)
  }
  const access = new AccessStore(database(), () => builtInTools),
    turnId = crypto.randomUUID()
  let harness: Harness
  const objects = piWorkingObjects(
    async () => harness,
    () => true
  )
  const registry = createRegistry()
  registry.install({
    name: "objects",
    tools: objectTools(objects, (api) => ({
      actor: "agent",
      surface: "tool",
      turnId,
      toolCallId: api.callId,
    })).map(
      guardedTools(
        new AccessGate(
          access,
          () => true,
          () => {}
        ),
        () => Effect.succeed(turnId)
      )
    ),
    hooks: [objectContextHook(objects)],
  })
  const options = {
    models,
    registry,
    settings: { retry: { enabled: false }, compaction: { enabled: false } },
  }
  harness = await Harness.open(await openNodeSqliteStorage(path), options, ctx)
  try {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "create_checklist",
          {
            title: "Website launch",
            notes: "Accessible and simple",
            tasks: [
              {
                title: "Draft homepage",
                status: "pending",
                dueDate: "2026-10-16",
                notes: "Actual product screens",
              },
            ],
          },
          { id: "create" }
        ),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("The checklist is ready."),
    ])
    const first = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    await (
      await first.submit(
        {
          type: "input",
          requestId: turnId,
          content: [{ type: "text", text: "Help plan my website launch." }],
        },
        ctx
      )
    ).wait(ctx)
    await first.waitForIdle(ctx)
    expect(access.pending()).toHaveLength(0)
    const listed = await execute(objects.list()),
      objectId = listed[0]!.id
    const detail = await execute(objects.read(objectId)),
      taskId = detail.object.tasks[0]!.id
    expect(detail.object.origin).toEqual({
      actor: "agent",
      surface: "tool",
      turnId,
      toolCallId: "create",
    })
    const operation: ObjectMutation = {
      id: objectId,
      operationId: crypto.randomUUID(),
      expectedRevision: 1,
      action: {
        type: "update",
        changes: [
          {
            type: "edit_task",
            taskId,
            patch: { status: "completed", notes: "Reviewed on mobile" },
          },
        ],
      },
    }
    const request = () =>
      new Request("https://internal/objects/mutate", {
        method: "POST",
        body: JSON.stringify(operation),
      })
    expect(
      (
        await Effect.runPromise(
          objectsRequest(objects, request(), "objects/mutate", () => undefined)
        )
      ).status
    ).toBe(200)
    expect(
      (
        await Effect.runPromise(
          objectsRequest(objects, request(), "objects/mutate", () => undefined)
        )
      ).status
    ).toBe(200)
    expect((await execute(objects.read(objectId))).events).toHaveLength(2)
    expect(requests).toHaveLength(2)
    expect((await execute(objects.context())).offeredThrough).toBe(1)
    await harness.close(ctx)
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("read_object", { id: objectId }, { id: "read" }),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("I see your mobile review is complete."),
    ])
    const second = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      ctx
    )
    await (
      await second.submit(
        {
          type: "input",
          requestId: crypto.randomUUID(),
          content: [{ type: "text", text: "Continue from the checklist." }],
        },
        ctx
      )
    ).wait(ctx)
    await second.waitForIdle(ctx)
    expect(requests.at(-2)).toContain('\\"changed\\":true')
    expect(requests.at(-1)).toContain("Reviewed on mobile")
    expect(
      requests.at(-1)!.match(/Working objects: current server-generated/g) ?? []
    ).toHaveLength(1)
    const events = await watchEvents(harness, second.id, ctx)
    const timeline = piTimeline(events.snapshot.entries)
    expect(JSON.stringify(timeline)).toContain("Reviewed on mobile")
    expect(JSON.stringify(events.snapshot.entries)).not.toContain(
      "Working objects: current server-generated"
    )
    expect((await execute(objects.context())).offeredThrough).toBe(2)
    await events.stop()
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it("keeps large valid object reads parseable through the receipt boundary with complete task pagination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "object-pages-"))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  const objects = piWorkingObjects(
    async () => harness,
    () => true
  )
  try {
    const base = create()
    if (base.action.type !== "create") throw new Error("fixture")
    const input = {
      ...base,
      action: {
        ...base.action,
        notes: "\u0000".repeat(4000),
        tasks: Array.from({ length: 20 }, (_, index) => ({
          id: crypto.randomUUID(),
          title: `Task ${index}`,
          notes: "\n".repeat(2000),
          dueDate: null,
          status: "pending" as const,
        })),
      },
    }
    await execute(objects.mutate(input, user))
    for (let revision = 1; revision <= 20; revision++)
      await execute(
        objects.mutate(
          {
            ...edit(input.id, revision, "unused"),
            action: {
              type: "update",
              changes: input.action.tasks.map((task) => ({
                type: "edit_task",
                taskId: task.id,
                patch: {
                  title: `Task r${revision}`,
                  notes: `${revision}\n`.repeat(600),
                  status: revision % 2 ? "active" : "pending",
                  dueDate: revision % 2 ? "2026-10-16" : null,
                },
              })),
            },
          },
          user
        )
      )
    const tool = objectTools(objects, () => user).find(
      (item) => item.name === "read_object"
    )!
    let offset: number | null = 0
    const seen: string[] = []
    do {
      const raw = await tool.execute(
        { id: input.id, taskOffset: offset },
        {} as never,
        ctx
      )
      const bounded = toolReceipt(raw)
      expect(JSON.stringify(raw).length).toBeLessThanOrEqual(64_000)
      expect(bounded).toEqual(raw)
      const block = bounded.content![0]!
      if (block.type !== "text") throw new Error("Expected JSON text")
      const page: { object: Checklist; nextTaskOffset: number | null } =
        JSON.parse(block.text)
      expect(page.object.revision).toBe(21)
      expect(page.object.notes).toBe(input.action.notes)
      seen.push(...page.object.tasks.map((task: { id: string }) => task.id))
      offset = page.nextTaskOffset
    } while (offset !== null)
    expect(seen).toEqual(input.action.tasks.map((task) => task.id))
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

it.each([
  "before",
  "after",
  "revoked-before",
  "expired-before",
  "revoked-after",
  "cancelled-after",
])(
  "recovers a native in-flight object tool at %s commit without duplicate effects or new authority",
  async (scenario) => {
    const directory = await mkdtemp(join(tmpdir(), "object-recovery-")),
      path = join(directory, "pi.sqlite"),
      db = database()
    let now = Date.now(),
      active = true,
      firstProcess = true,
      entered!: () => void
    const interrupted = new Promise<void>((resolve) => {
      entered = resolve
    })
    const access = new AccessStore(
        db,
        () => builtInTools,
        () => now
      ),
      turnId = crypto.randomUUID()
    const models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 100000 })
    models.setProvider(faux.provider)
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "create_checklist",
          { title: "Crash recovery", notes: "", tasks: [] },
          { id: "create" }
        ),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Checked the recovered outcome."),
    ])
    let harness: Harness
    const objects = piWorkingObjects(
      async () => harness,
      () => active
    )
    const options = () => {
      const registry = createRegistry(),
        protect = guardedTools(
          new AccessGate(access, () => active),
          () => Effect.succeed(turnId),
          recoverableObjectTools
        )
      registry.install({
        name: "objects",
        tools: objectTools(objects, (api) => ({
          actor: "agent",
          surface: "tool",
          turnId,
          toolCallId: api.callId,
        })).map((tool) =>
          protect({
            ...tool,
            execute: async (args, api, context) => {
              if (!firstProcess || tool.name !== "create_checklist")
                return tool.execute(args as object, api, context)
              if (scenario.endsWith("after"))
                await tool.execute(args as object, api, context)
              entered()
              return new Promise((_, reject) => {
                const abort = () =>
                  reject(new Error("Synthetic native shutdown"))
                if (context.abortSignal?.aborted) abort()
                else
                  context.abortSignal?.addEventListener("abort", abort, {
                    once: true,
                  })
              })
            },
          })
        ),
      })
      return {
        models,
        registry,
        settings: { retry: { enabled: false }, compaction: { enabled: false } },
      }
    }
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options(),
      ctx
    )
    try {
      let conversation = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      })
      const command = {
        type: "input" as const,
        requestId: turnId,
        content: [
          { type: "text" as const, text: "Create a project checklist." },
        ],
      }
      const first = await conversation.submit(command, ctx)
      await interrupted
      expect((await execute(objects.list())).length).toBe(
        scenario.endsWith("after") ? 1 : 0
      )
      await harness.close(ctx)
      firstProcess = false
      if (scenario.startsWith("revoked")) {
        access.update("create_checklist", 0, "deny")
        access.update("create_checklist", 1, "allow")
      }
      if (scenario.startsWith("expired")) now += 16 * 60_000
      if (scenario.startsWith("cancelled")) {
        active = false
        access.cancel(turnId)
      }
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options(),
        ctx
      )
      conversation = (await harness.conversation(conversation.id, ctx))!
      const resumed = await conversation.submit(command, ctx)
      expect(resumed.id).toBe(first.id)
      await resumed.wait(ctx)
      await conversation.waitForIdle(ctx)
      const expectedCount =
        scenario.endsWith("after") || scenario === "before" ? 1 : 0
      const list = await execute(objects.list())
      expect(list).toHaveLength(expectedCount)
      if (list[0])
        expect((await execute(objects.read(list[0].id))).events).toHaveLength(1)
      expect((await conversation.submit(command, ctx)).id).toBe(first.id)
      expect((await execute(objects.list())).length).toBe(expectedCount)
      const events = await watchEvents(harness, conversation.id, ctx)
      const transcript = JSON.stringify(events.snapshot.entries)
      if (scenario.startsWith("revoked"))
        expect(transcript).toContain("Tool access changed")
      else if (scenario.startsWith("expired"))
        expect(transcript).toContain("expired")
      else if (scenario.startsWith("cancelled"))
        expect(transcript).toContain("stopped")
      else expect(transcript).toContain("objectId")
      await events.stop()
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)
