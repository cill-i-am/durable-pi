import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Harness, createRegistry } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai"
import { piPlans } from "../src/planning/adapters/pi"
import { planTools, recoverablePlanTools } from "../src/planning/adapters/tools"
import { AccessStore } from "../src/access/adapters/sqlite"
import { AccessGate } from "../src/access/gate"
import { guardedTools } from "../src/access/adapters/pi"
import { builtInTools } from "../src/access/contracts"
import { database } from "./database"

it("pages maximally escaped plan summaries through actual native tool and durable receipt boundaries without cutting JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "plan-pages-")),
    models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1000000 })
  models.setProvider(faux.provider)
  let root = crypto.randomUUID()
  const source = () => ({ turnId: root, inputIds: [root], inputRevision: 0 })
  const plans = piPlans(async () => harness, {
    current: source,
    cancelled: () => false,
    evidence: (ref) =>
      Effect.succeed({ ...ref, state: "valid", detail: "Saved" }),
    receipts: () => [],
  })
  const registry = createRegistry(),
    access = new AccessStore(database(), () => builtInTools)
  registry.install({
    name: "plans",
    tools: planTools(plans, source).map(
      guardedTools(
        new AccessGate(access, () => true),
        () => Effect.succeed(root),
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
  const seen: string[] = [],
    sizes: number[] = []
  let detailId = ""
  try {
    const large = "x" + "\u0001".repeat(999)
    for (let i = 0; i < 20; i++) {
      root = crypto.randomUUID()
      detailId = crypto.randomUUID()
      await Effect.runPromise(
        plans.update(
          {
            id: detailId,
            operationId: `tool:${1000 + i}`,
            relation: "new",
            expectedRevision: 0,
            inputRevision: 0,
            reason: "Track task",
            draft: {
              objective: large,
              constraints: [],
              criteria: ["Answer available"],
              steps: [
                {
                  id: "wait",
                  title: "Wait for information",
                  status: "blocked",
                  evidence: [],
                  note: "",
                },
              ],
              complete: false,
              nextAction: "",
              blocker: large,
            },
          },
          source()
        )
      )
    }
    root = crypto.randomUUID()
    let index = 0
    faux.setResponses(
      Array.from({ length: 15 }, () => async (input) => {
        const last = input.messages.at(-1)
        let offset = 0
        if (last?.role === "toolResult") {
          const text = last.content.find((block) => block.type === "text")
          if (!text) throw new Error("Missing JSON page")
          const page = JSON.parse(text.text) as {
            plans: { id: string }[]
            nextOffset: number | null
          }
          seen.push(...page.plans.map((plan) => plan.id))
          sizes.push(page.plans.length)
          if (page.nextOffset === null)
            return fauxAssistantMessage("All tasks inspected.")
          offset = page.nextOffset
        }
        return fauxAssistantMessage(
          fauxToolCall("read_plan", { offset }, { id: `read-${index++}` }),
          { stopReason: "toolUse" }
        )
      })
    )
    const conversation = await harness.root(ctx, {
      agent: { model: { provider: "faux", modelId: "faux-1" } },
    })
    await (
      await conversation.submit(
        {
          type: "input",
          requestId: root,
          content: [{ type: "text", text: "List the saved tasks." }],
        },
        ctx
      )
    ).wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(seen).toHaveLength(20)
    expect(new Set(seen).size).toBe(20)
    expect(sizes[0]).toBeLessThan(20)
    expect(access.pending()).toHaveLength(0)
    root = crypto.randomUUID()
    const crowded = {
      objective: large,
      constraints: Array.from({ length: 10 }, () => "x" + "\u0001".repeat(499)),
      criteria: Array.from({ length: 10 }, () => "x" + "\u0001".repeat(499)),
      steps: Array.from({ length: 20 }, (_, i) => ({
        id: `step${i}`,
        title: "Inspect evidence",
        status: "pending" as const,
        evidence: [],
        note: large,
      })),
      complete: false,
      nextAction: large,
      blocker: large,
    }
    await Effect.runPromise(
      plans.update(
        {
          id: detailId,
          operationId: "tool:9000",
          relation: "continue",
          expectedRevision: 1,
          inputRevision: 0,
          reason: "Include all details",
          draft: crowded,
        },
        source()
      )
    )
    const items: unknown[] = []
    faux.setResponses(
      Array.from({ length: 15 }, () => async (input) => {
        const last = input.messages.at(-1)
        let offset = 0
        if (last?.role === "toolResult") {
          const text = last.content.find((block) => block.type === "text")
          if (!text) throw new Error("Missing JSON detail")
          expect(
            new TextEncoder().encode(text.text).byteLength
          ).toBeLessThanOrEqual(40000)
          const page = JSON.parse(text.text) as {
            items: unknown[]
            nextOffset: number | null
          }
          items.push(...page.items)
          if (page.nextOffset === null)
            return fauxAssistantMessage("Complete plan inspected.")
          offset = page.nextOffset
        }
        return fauxAssistantMessage(
          fauxToolCall(
            "read_plan",
            { id: detailId, offset },
            { id: `detail-${index++}` }
          ),
          { stopReason: "toolUse" }
        )
      })
    )
    await (
      await conversation.submit(
        {
          type: "input",
          requestId: root,
          content: [{ type: "text", text: "Read the complete plan." }],
        },
        ctx
      )
    ).wait(ctx)
    await conversation.waitForIdle(ctx)
    expect(items).toEqual([
      { kind: "objective", value: crowded.objective },
      ...crowded.constraints.map((value) => ({ kind: "constraint", value })),
      ...crowded.criteria.map((value) => ({ kind: "criterion", value })),
      ...crowded.steps.map((value) => ({ kind: "step", value })),
      { kind: "nextAction", value: crowded.nextAction },
      { kind: "blocker", value: crowded.blocker },
    ])
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
