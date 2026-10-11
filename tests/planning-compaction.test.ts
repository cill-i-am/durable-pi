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
import { agentSettings } from "../src/agent/compaction"
import { originalTranscript } from "../src/conversations/adapters/pi-reply"
import { piPlans } from "../src/planning/adapters/pi"
import { planContextHook } from "../src/planning/tools"

it("supplies the authoritative plan after native compaction and a storage restart, without adding context copies to original history", async () => {
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
          "Continue reading remaining pages. Keep output in metric units; do not publish."
        )
      }
      requests++
      const messages = JSON.stringify(input.messages)
      expect(messages.match(/Durable planning context/g)).toHaveLength(1)
      expect(messages).toContain("Read six pages and prepare a private report")
      expect(messages).toContain("Use metric units")
      return calls >= 6
        ? fauxAssistantMessage("All six pages read. Ready to draft the report.")
        : fauxAssistantMessage(
            fauxToolCall("read_page", {}, { id: `page-${calls}` }),
            { stopReason: "toolUse" }
          )
    })
  )
  const registry = createRegistry()
  registry.install({
    name: "fixture",
    hooks: [planContextHook(plans, () => source)],
    tools: [
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
  harness = await Harness.open(await openNodeSqliteStorage(path), options, ctx)
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
    expect(requests).toBe(7)
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
    expect(requests).toBe(7) // Reopening a saved plan schedules no model work.
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)
