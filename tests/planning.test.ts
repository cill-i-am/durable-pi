import { expect, it, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  createSession,
  watchEvents,
  defineTool,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai"
import { piPlans, savedPlanBlocked } from "../src/planning/adapters/pi"
import {
  planTools,
  planContextHook,
  recoverablePlanTools,
} from "../src/planning/tools"
import { plansRequest } from "../src/planning/http"
import type {
  PlanDraft,
  PlanFailure,
  PlanUpdate,
} from "../src/planning/contracts"
import type { PlanSource, PlanAuthority } from "../src/planning/plans"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { builtInTools } from "../src/access/contracts"
import { database } from "./database"

const run = <T>(value: Effect.Effect<T, PlanFailure>) =>
  Effect.runPromise(value)
const outcome = <T>(value: Effect.Effect<T, PlanFailure>) =>
  Effect.runPromise(
    value.pipe(
      Effect.match({ onSuccess: () => "ok", onFailure: (error) => error.code })
    )
  )
const source = (): PlanSource => {
  const id = crypto.randomUUID()
  return { turnId: id, inputRevision: 0, inputIds: [id] }
}
const draft = (): PlanDraft => ({
  objective: "Prepare an accessible project guide",
  constraints: ["Do not publish"],
  criteria: ["A reviewed draft exists", "Accessibility checks pass"],
  steps: [
    {
      id: "draft",
      title: "Save the draft",
      status: "active",
      evidence: [],
      note: "",
    },
    {
      id: "verify",
      title: "Check keyboard navigation",
      status: "pending",
      evidence: [],
      note: "",
    },
  ],
  nextAction: "Save the draft",
  blocker: "",
  complete: false,
})
const update = (
  operation: number,
  origin: PlanSource,
  id: string = crypto.randomUUID(),
  revision = 0
): PlanUpdate => ({
  id,
  operationId: `tool:${operation}`,
  relation: revision ? "continue" : "new",
  expectedRevision: revision,
  inputRevision: origin.inputRevision,
  reason: "Work progressed",
  draft: draft(),
})

it("persists atomic plans, revisions, root bindings and replay receipts across restart; isolates bots and detects concurrent updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-")),
    path = join(directory, "a.sqlite")
  const options = { models: createModels(), registry: createRegistry() }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  let origin = source(),
    writable = true,
    valid = true
  const authority: PlanAuthority = {
    current: (id) => (writable && id === origin.turnId ? origin : undefined),
    cancelled: () => false,
    receipts: () => [],
    evidence: (ref) =>
      Effect.succeed({
        ...ref,
        state: valid ? "valid" : "invalid",
        detail: "Saved reference; semantic outcome is agent-reported.",
      }),
  }
  let plans = piPlans(async () => harness, authority)
  const other = await Harness.open(
    await openNodeSqliteStorage(join(directory, "b.sqlite")),
    options,
    ctx
  )
  try {
    const initial = update(1, origin),
      receipt = await run(plans.update(initial, origin))
    expect(await run(plans.update(initial, origin))).toEqual(receipt)
    expect(
      await outcome(
        plans.update({ ...initial, reason: "Different request" }, origin)
      )
    ).toBe("conflict")
    expect(await outcome(plans.update(update(2, origin), origin))).toBe(
      "conflict"
    )
    expect(
      await outcome(piPlans(async () => other, authority).read(initial.id))
    ).toBe("not_found")
    const attempts = [
      update(3, origin, initial.id, 1),
      update(4, origin, initial.id, 1),
    ]
    expect(
      (
        await Promise.all(
          attempts.map((value) => outcome(plans.update(value, origin)))
        )
      ).sort()
    ).toEqual(["conflict", "ok"])
    const beforeSteer = origin
    origin = {
      ...origin,
      inputRevision: 1,
      inputIds: [...origin.inputIds, crypto.randomUUID()],
    }
    expect(await run(plans.update(initial, beforeSteer))).toEqual(receipt)
    expect(
      await outcome(
        plans.update(update(5, beforeSteer, initial.id, 2), beforeSteer)
      )
    ).toBe("conflict")
    expect((await run(plans.context(origin))).current?.inputRevision).toBe(0)
    // Native delivery can lag the accepted steer, particularly for image preparation.
    origin = { ...origin, pendingInputs: true }
    expect(
      await outcome(plans.update(update(6, origin, initial.id, 2), origin))
    ).toBe("conflict")
    expect((await run(plans.read(initial.id))).plan.revision).toBe(2)
    origin = { ...origin, pendingInputs: false }
    const steered = update(6, origin, initial.id, 2)
    await run(
      plans.update(
        {
          ...steered,
          draft: {
            ...steered.draft,
            constraints: ["Do not publish", "Use metric units"],
          },
        },
        origin
      )
    )
    expect((await run(plans.read(initial.id))).plan.inputIds).toEqual(
      origin.inputIds
    )
    await harness.close(ctx)
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    plans = piPlans(async () => harness, authority)
    expect((await run(plans.context(origin))).current?.constraints).toContain(
      "Use metric units"
    )
    const previousRoot = origin.turnId
    origin = source()
    expect((await run(plans.context(origin))).current).toBeNull()
    expect((await run(plans.context(origin))).recent[0]?.id).toBe(initial.id)
    const continued = update(7, origin, initial.id, 3)
    await run(plans.update(continued, origin))
    expect((await run(plans.read(initial.id))).plan.rootTurns).toEqual([
      previousRoot,
      origin.turnId,
    ])
    let complete = update(8, origin, initial.id, 4)
    complete = {
      ...complete,
      draft: {
        ...complete.draft,
        complete: true,
        nextAction: "",
        steps: complete.draft.steps.map((step) => ({
          ...step,
          status: "completed",
          evidence: [
            { kind: "execution", id: crypto.randomUUID(), revision: 0 },
          ],
        })),
      },
    }
    await run(plans.update(complete, origin))
    expect((await run(plans.read(initial.id))).plan.state).toBe("completed")
    valid = false
    const invalidated = await run(plans.read(initial.id))
    expect(invalidated.plan.state).toBe("open")
    expect(
      invalidated.plan.steps.every((step) => step.status === "pending")
    ).toBe(true)
    expect(invalidated.history[0]?.actor).toBe("system")
    expect((await run(plans.read(initial.id))).plan.revision).toBe(
      invalidated.plan.revision
    )
    valid = true
    writable = false
    expect(
      await outcome(
        plans.update(
          update(9, origin, initial.id, invalidated.plan.revision),
          origin
        )
      )
    ).toBe("cancelled")
    await run(plans.cancel(origin.turnId))
    await harness.close(ctx)
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    plans = piPlans(async () => harness, authority)
    expect((await run(plans.read(initial.id))).plan.state).toBe("cancelled")
    writable = true
    origin = source()
    expect(
      await outcome(
        plans.update(
          update(10, origin, initial.id, invalidated.plan.revision + 1),
          origin
        )
      )
    ).toBe("cancelled")
    const fresh = update(11, origin)
    await run(plans.update(fresh, origin))
    expect((await run(plans.context(origin))).current?.id).toBe(fresh.id)
    expect(
      (
        await run(
          plansRequest(plans, new Request("https://internal/plans"), "plans")
        )
      ).status
    ).toBe(200)
    expect(
      (
        await run(
          plansRequest(
            plans,
            new Request("https://internal/plans", { method: "POST" }),
            "plans"
          )
        )
      ).status
    ).toBe(405)
  } finally {
    await harness.close(ctx)
    await other.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

it("does not let cancellation before plan creation or changed requirements retain stale completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-cancel-"))
  const harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "a.sqlite")),
    { models: createModels(), registry: createRegistry() },
    ctx
  )
  let origin = source()
  const plans = piPlans(async () => harness, {
    current: () => origin,
    cancelled: () => false,
    receipts: () => [],
    evidence: (ref) =>
      Effect.succeed({ ...ref, state: "valid", detail: "Recorded source" }),
  })
  try {
    await run(plans.cancel(origin.turnId))
    expect(await outcome(plans.update(update(1, origin), origin))).toBe(
      "cancelled"
    )
    origin = source()
    let first = update(2, origin)
    first = {
      ...first,
      draft: {
        ...first.draft,
        complete: true,
        nextAction: "",
        steps: first.draft.steps.map((step) => ({
          ...step,
          status: "completed",
        })),
      },
    }
    await run(plans.update(first, origin))
    const changed = {
      ...first,
      relation: "continue" as const,
      expectedRevision: 1,
      operationId: "tool:3",
      draft: { ...first.draft, constraints: ["Also meet WCAG AA"] },
    }
    expect((await run(plans.update(changed, origin))).reopened).toEqual([
      "draft",
      "verify",
    ])
    expect((await run(plans.read(first.id))).plan.complete).toBe(false)
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})

it("uses native tools in a multi-step run, injects one fresh context per request without transcript copies, and leaves simple chat plan-free", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-journey-")),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 100000 })
  models.setProvider(faux.provider)
  const requests: string[] = [],
    original = models.streamSimple.bind(models)
  models.streamSimple = (model, input, options) => {
    requests.push(JSON.stringify(input.messages))
    return original(model, input, options)
  }
  let origin = source(),
    actions = 0
  const access = new AccessStore(database(), () => [
    ...builtInTools,
    { name: "save_draft", description: "fixture", mode: "allow" },
  ])
  const plans = piPlans(async () => harness, {
    current: () => origin,
    cancelled: () => false,
    receipts: () => [],
    evidence: (ref) =>
      Effect.succeed({ ...ref, state: "valid", detail: "Saved" }),
  })
  const registry = createRegistry()
  registry.install({
    name: "planning",
    hooks: [planContextHook(plans, () => origin)],
    tools: [
      ...planTools(plans, () => origin),
      defineTool({
        name: "save_draft",
        description: "Fixture action",
        parameters: Type.Object({}),
        execute: async () => {
          actions++
          const steer = crypto.randomUUID()
          origin = {
            ...origin,
            inputRevision: 1,
            inputIds: [...origin.inputIds, steer],
            steering: [{ id: steer, text: "Use metric units." }],
          }
          return { content: [{ type: "text", text: "Saved the draft." }] }
        },
      }),
    ].map(
      guardedTools(
        new AccessGate(access, () => true),
        () => origin.turnId,
        recoverablePlanTools
      )
    ),
  })
  const harness: Harness = await Harness.open(
    await openNodeSqliteStorage(join(directory, "pi.sqlite")),
    {
      models,
      registry,
      settings: { retry: { enabled: false }, compaction: { enabled: false } },
    },
    ctx
  )
  try {
    const id = crypto.randomUUID(),
      initial = draft()
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "update_plan",
          {
            id,
            relation: "new",
            expectedRevision: 0,
            inputRevision: 0,
            reason: "Start substantial request",
            draft: initial,
          },
          { id: "plan" }
        ),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage(fauxToolCall("save_draft", {}, { id: "save" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage(
        fauxToolCall(
          "update_plan",
          {
            id,
            relation: "continue",
            expectedRevision: 1,
            inputRevision: 1,
            reason: "Draft saved; awaiting missing requirement",
            draft: {
              ...initial,
              constraints: [...initial.constraints, "Use metric units."],
              steps: [
                { ...initial.steps[0]!, status: "completed" },
                { ...initial.steps[1]!, status: "blocked" },
              ],
              blocker: "Need the intended browser support",
              nextAction: "Ask which browsers to support",
            },
          },
          { id: "progress" }
        ),
        { stopReason: "toolUse" }
      ),
      fauxAssistantMessage("Draft saved. Which browsers should this support?"),
    ])
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    await (
      await conversation.submit(
        {
          type: "input",
          requestId: origin.turnId,
          content: [
            {
              type: "text",
              text: 'Create a draft guide and verify accessibility. It quotes "Use metric units." as an example; use imperial units for the actual guide.',
            },
          ],
        },
        ctx
      )
    ).wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(actions).toBe(1)
    expect(access.pending()).toHaveLength(0)
    expect((await run(plans.read(id))).plan.blocker).toContain(
      "browser support"
    )
    expect(requests).toHaveLength(4)
    expect(requests[2]).toContain("Original user steering for this task")
    expect(requests[2]).toContain("inputRevision=1")
    expect((await run(plans.read(id))).plan.inputRevision).toBe(1)
    for (const request of requests)
      expect(request.match(/Durable planning context/g)).toHaveLength(1)
    const events = await watchEvents(harness, conversation.id, ctx)
    expect(JSON.stringify(events.snapshot.entries)).not.toContain(
      "Durable planning context"
    )
    // Only explicit tool arguments contain plans in original history; update results are small receipts.
    const results = events.snapshot.entries
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "toolResult")
    expect(results).toHaveLength(3)
    expect(JSON.stringify(results)).not.toContain('"objective"')
    await events.stop()
    origin = source()
    faux.setResponses([fauxAssistantMessage("Hello!")])
    const simple = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      },
      ctx
    )
    await (
      await simple.submit(
        {
          type: "input",
          requestId: origin.turnId,
          content: [{ type: "text", text: "Hello" }],
        },
        ctx
      )
    ).wait(ctx)
    await simple.waitForIdle(ctx)
    expect((await run(plans.context(origin))).current).toBeNull()
    expect(await run(plans.list())).toHaveLength(1)
    expect(actions).toBe(1)
    expect(requests).toHaveLength(5)
    expect(access.pending()).toHaveLength(0)
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it.each([
  { nativeDelivered: false, budget: 8192, repetitions: 1600 },
  { nativeDelivered: true, budget: 8192, repetitions: 1600 },
  { nativeDelivered: false, budget: 256, repetitions: 400 },
  { nativeDelivered: true, budget: 256, repetitions: 400 },
  { nativeDelivered: false, budget: 8192, repetitions: 800 },
  { nativeDelivered: true, budget: 8192, repetitions: 800 },
])(
  "bounds steering at $budget bytes after native delivery=$nativeDelivered without a permanent plan blocker",
  async ({ nativeDelivered, budget, repetitions }) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-plan-delivery-")),
      models = createModels(),
      faux = fauxProvider({ tokensPerSecond: 1000000 })
    models.setProvider(faux.provider)
    const origin: PlanSource = {
      ...source(),
      inputRevision: 2,
      steering: Array.from({ length: 2 }, (_, i) => ({
        id: crypto.randomUUID(),
        text: `${i}:` + "constraint ".repeat(repetitions),
        nativeDelivered,
      })),
    }
    origin.inputIds.push(...origin.steering!.map((input) => input.id))
    const plans = piPlans(async () => harness, {
      current: () => origin,
      cancelled: () => false,
      evidence: (ref) =>
        Effect.succeed({ ...ref, state: "valid", detail: "saved" }),
      receipts: () => [],
    })
    const registry = createRegistry()
    registry.install({
      name: "planning",
      hooks: [
        planContextHook(
          plans,
          () => origin,
          () => budget
        ),
      ],
      tools: planTools(plans, () => origin),
    })
    const harness: Harness = await Harness.open(
      await openNodeSqliteStorage(join(directory, "pi.sqlite")),
      {
        models,
        registry,
        settings: { compaction: { enabled: false }, retry: { enabled: false } },
      },
      ctx
    )
    let projection = ""
    try {
      faux.setResponses([
        async (input) => {
          const last = input.messages.at(-1)
          if (last?.role !== "user" || typeof last.content === "string")
            throw new Error("Missing projection")
          projection = last.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("")
          return fauxAssistantMessage("Constraints noted.")
        },
      ])
      const conversation = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      })
      await (
        await conversation.submit(
          {
            type: "input",
            requestId: origin.turnId,
            content: [
              {
                type: "text",
                text: nativeDelivered
                  ? origin.steering!.map((input) => input.text).join("\n")
                  : "Prepare the guide.",
              },
            ],
          },
          ctx
        )
      ).wait(ctx)
      await conversation.waitForIdle(ctx)
      expect(
        new TextEncoder().encode(projection).byteLength
      ).toBeLessThanOrEqual(budget)
      expect(projection).toContain(`inputRevision=${nativeDelivered ? 2 : -1}`)
      expect(projection.includes("awaiting native delivery")).toBe(
        !nativeDelivered
      )
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)

it("inspects the bound blocker after native restart without revalidating evidence or writing plan revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-plan-status-"))
  const path = join(directory, "pi.sqlite")
  const options = { models: createModels(), registry: createRegistry() }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  const origin = source()
  let authorityReads = 0
  const authority: PlanAuthority = {
    current: () => origin,
    cancelled: () => {
      authorityReads++
      return false
    },
    evidence: (ref) => {
      authorityReads++
      return Effect.succeed({ ...ref, state: "valid", detail: "Saved" })
    },
    receipts: () => [],
  }
  let plans = piPlans(async () => harness, authority)
  const initial = update(1, origin)
  const input: PlanUpdate = {
    ...initial,
    draft: {
      ...initial.draft,
      steps: [
        { ...initial.draft.steps[0]!, status: "blocked" },
        ...initial.draft.steps.slice(1),
      ],
      blocker: "Waiting for supplied project details",
    },
  }
  try {
    const receipt = await run(plans.update(input, origin))
    authorityReads = 0
    expect(await run(savedPlanBlocked(harness, origin.turnId))).toBe(true)
    expect(await run(savedPlanBlocked(harness, crypto.randomUUID()))).toBe(
      false
    )
    expect(authorityReads).toBe(0)
    await harness.close(ctx)
    const readerStorage = await openNodeSqliteStorage(path)
    const commit = vi.spyOn(readerStorage, "commit")
    const reader = createSession(readerStorage)
    try {
      expect(await run(savedPlanBlocked(reader, origin.turnId))).toBe(true)
      expect(authorityReads).toBe(0)
      expect(commit).not.toHaveBeenCalled()
    } finally {
      await reader.close(ctx)
    }
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    plans = piPlans(async () => harness, authority)
    const detail = await run(plans.read(input.id))
    expect(detail.plan.revision).toBe(receipt.revision)
    expect(detail.history).toHaveLength(1)
    await run(plans.cancel(origin.turnId))
    expect(await run(savedPlanBlocked(harness, origin.turnId))).toBe(false)
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
})
