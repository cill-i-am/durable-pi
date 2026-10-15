import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import {
  Harness,
  createRegistry,
  defineTool,
  watchEvents,
} from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import {
  createModels,
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai"
import { agentSettings, contextProjectionBytes } from "../src/agent/compaction"
import { originalTranscript } from "../src/conversations/adapters/pi-reply"
import { piPlans } from "../src/planning/adapters/pi"
import { planContextHook, planTools } from "../src/planning/adapters/tools"

it.each([8192, contextProjectionBytes(8192)])(
  "retrieves the authoritative plan with a %i-byte projection through native compaction and restart without history copies",
  async (budget) => {
    const directory = await mkdtemp(join(tmpdir(), "plan-compaction-")),
      path = join(directory, "pi.sqlite")
    const models = createModels(),
      faux = fauxProvider({
        models: [{ id: "small", contextWindow: 8192, maxTokens: 2048 }],
        tokensPerSecond: 1000000,
      })
    models.setProvider(faux.provider)
    let harness: Harness,
      calls = 0,
      summaries = 0,
      requests = 0
    const projectionBytes: number[] = []
    const root = crypto.randomUUID(),
      id = crypto.randomUUID(),
      source = { turnId: root, inputRevision: 0, inputIds: [root] }
    const plans = piPlans(async () => harness, {
      current: () => source,
      cancelled: () => false,
      receipts: () => [],
      evidence: (ref) =>
        Effect.succeed({ ...ref, state: "valid", detail: "Saved" }),
    })
    faux.setResponses(
      Array.from({ length: 40 }, () => async (input, options) => {
        if (options?.cacheRetention === "none") {
          summaries++
          return fauxAssistantMessage(
            "Read six pages and prepare a private report. Use metric units; do not publish. The saved plan contains the remaining work."
          )
        }
        requests++
        const messages = JSON.stringify(input.messages)
        expect(messages.match(/Durable planning context/g)).toHaveLength(1)
        const projection = input.messages.at(-1)
        if (
          projection?.role !== "user" ||
          typeof projection.content === "string"
        )
          throw new Error("Missing plan context")
        const contextText = projection.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("")
        projectionBytes.push(new TextEncoder().encode(contextText).byteLength)
        expect(contextText).toContain(id)
        if (requests === 1)
          return fauxAssistantMessage(
            fauxToolCall("read_plan", { id }, { id: "read-plan" }),
            { stopReason: "toolUse" }
          )
        expect(messages).toContain(
          "Read six pages and prepare a private report"
        )
        expect(messages).toContain("Use metric units")
        return calls >= 6
          ? fauxAssistantMessage(
              "All six pages read. Ready to draft the report."
            )
          : fauxAssistantMessage(
              fauxToolCall("read_page", {}, { id: `page-${calls}` }),
              { stopReason: "toolUse" }
            )
      })
    )
    const registry = createRegistry()
    registry.install({
      name: "fixture",
      hooks: [
        planContextHook(
          plans,
          () => source,
          () => budget
        ),
      ],
      tools: [
        ...planTools(plans, () => source).filter(
          (tool) => tool.name === "read_plan"
        ),
        defineTool({
          name: "read_page",
          description: "Read a synthetic page",
          parameters: Type.Object({}),
          replay: "safe",
          execute: async () => {
            calls++
            return {
              content: [
                { type: "text", text: "Original source detail ".repeat(300) },
              ],
            }
          },
        }),
      ],
    })
    const options = {
      models,
      registry,
      settings: agentSettings(() => faux.getModel("small")),
    }
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    try {
      await Effect.runPromise(
        plans.update(
          {
            id,
            operationId: "tool:9999",
            relation: "new",
            expectedRevision: 0,
            inputRevision: 0,
            reason: "Start substantial research",
            draft: {
              objective: "Read six pages and prepare a private report",
              constraints: ["Use metric units", "Do not publish"],
              criteria: ["All sources reviewed", "Report saved"],
              steps: [
                {
                  id: "read",
                  title: "Read sources",
                  status: "active",
                  note: "",
                  evidence: [],
                },
                {
                  id: "report",
                  title: "Save report",
                  status: "pending",
                  note: "",
                  evidence: [],
                },
                ...Array.from({ length: 18 }, (_, index) => ({
                  id: `detail_${index}`,
                  title: `Inspect source detail ${index}`,
                  status: "pending" as const,
                  note: "Source detail. ".repeat(66),
                  evidence: [],
                })),
              ],
              nextAction: "Read the next page",
              blocker: "",
              complete: false,
            },
          },
          source
        )
      )
      const conversation = await harness.root(ctx, {
        agent: { model: { provider: "faux", modelId: "small" } },
      })
      await (
        await conversation.submit(
          {
            type: "input",
            requestId: root,
            content: [{ type: "text", text: "Read the six pages." }],
          },
          ctx
        )
      ).wait(ctx)
      await conversation.waitForIdle(ctx)
      expect(calls).toBe(6)
      expect(requests).toBe(8)
      expect(Math.max(...projectionBytes)).toBeLessThanOrEqual(budget)
      expect(summaries).toBeGreaterThan(0)
      const events = await watchEvents(harness, conversation.id, ctx)
      const original = await originalTranscript(conversation, events.snapshot)
      expect(JSON.stringify(original)).not.toContain("Durable planning context")
      await events.stop()
      await harness.close(ctx)
      harness = await Harness.open(
        await openNodeSqliteStorage(path),
        options,
        ctx
      )
      const context = await Effect.runPromise(plans.context(source))
      expect(context.current?.revision).toBe(1)
      expect(context.current?.steps[1]?.status).toBe("pending")
      expect(context.current?.constraints).toContain("Use metric units")
      expect(context.current?.steps[19]?.note).toBe(
        "Source detail. ".repeat(66)
      )
      expect(requests).toBe(8)
    } finally {
      await harness.close(ctx)
      await rm(directory, { recursive: true, force: true })
    }
  },
  15000
)
