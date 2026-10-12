import { expect, it } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Type } from "@earendil-works/pi-ai"
import { createAgentModels, accountCredentials } from "../src/agent/models"
import { InferenceUsage } from "../src/inference/usage"
import { resolveRoute } from "../src/inference/policy"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { submissionAttempt } from "../src/features/conversation/commands"
import { database } from "./database"
import { catalog, credential, response } from "./inference-fixture"

it("carries a composer override into native Pi Responses and preserves selection and completed actions across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-routing-")),
    path = join(directory, "pi.sqlite")
  const db = database(),
    store = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    }),
    usage = new InferenceUsage(db)
  const command = submissionAttempt(
    null,
    "Save the result, then verify it.",
    "followUp",
    [],
    "deep"
  )
  const route = {
    ...resolveRoute("conversation", undefined, command.profile),
    contextWindow: 272000,
  }
  const turn = store.admit(command, undefined, [], route).turn
  const payloads: Record<string, unknown>[] = []
  const telemetry: Promise<unknown>[] = []
  let toolCalls = 0,
    recovering = false
  let ready!: () => void
  const atSecondRequest = new Promise<void>((resolve) => {
    ready = resolve
  })
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      waitUntil: (work) => {
        telemetry.push(work)
        if (telemetry.length === 1)
          throw new Error("Synthetic host lifetime ended")
      },
      catalog: async () => catalog,
      onAttempt: () => usage.start(route, turn.id, "conversation"),
    }
  )
  const provider = models.getProvider("openai")!
  models.setProvider({
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        fetch: async (_url, init) => {
          const payload = JSON.parse(String(init?.body))
          payloads.push(payload)
          expect(payload.model).toBe(turn.model)
          expect(payload.reasoning.effort).toBe(turn.thinking)
          expect(payload.store).toBe(false)
          expect(payload.max_output_tokens).toBeUndefined()
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer synthetic-local-access"
          )
          if (JSON.stringify(payload.input).includes("function_call_output")) {
            if (!recovering) {
              ready()
              await new Promise((_, reject) => {
                init?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("Synthetic runtime stopped")),
                  { once: true }
                )
              })
            }
            return response(model.id)
          }
          return response(model.id, "tool")
        },
      }),
  })
  const registry = createRegistry()
  registry.install({
    name: "routing-proof",
    tools: [
      defineTool({
        name: "save_result",
        description: "Save one synthetic result",
        parameters: Type.Object({}),
        replay: "unsafe",
        execute: async () => {
          toolCalls++
          return { content: [{ type: "text", text: "result saved once" }] }
        },
      }),
    ],
  })
  const options = {
    models,
    registry,
    settings: { compaction: { enabled: false }, retry: { enabled: false } },
  }
  let harness = await Harness.open(
    await openNodeSqliteStorage(path),
    options,
    ctx
  )
  try {
    let conversation = await harness.root(ctx, {
      agent: {
        model: { provider: "openai", modelId: turn.model! },
        thinkingLevel: turn.thinking!,
      },
    })
    const original = await conversation.submit(
      { type: "input", requestId: turn.id, content: turn.text },
      ctx
    )
    await atSecondRequest
    store.setSettings({ model: "gpt-6-luna", thinking: "low" })
    await harness.close(ctx)
    recovering = true
    harness = await Harness.open(
      await openNodeSqliteStorage(path),
      options,
      ctx
    )
    conversation = await harness.root(ctx)
    const replay = await conversation.submit(
      { type: "input", requestId: turn.id, content: turn.text },
      ctx
    )
    expect(replay.id).toBe(original.id)
    expect((await replay.wait(ctx)).status).toBe("done")
    expect(toolCalls).toBe(1)
    expect(payloads.length).toBeGreaterThanOrEqual(3)
    expect(telemetry).toHaveLength(payloads.length)
    await Promise.all(telemetry)
    expect(
      new ConversationStore(db, { model: "gpt-6-luna", thinking: "low" }).get(
        turn.id
      )?.routing
    ).toEqual(route)
    expect(usage.recent()[0]).toMatchObject({
      route,
      turnId: turn.id,
      outcome: "completed",
      reportedModel: "gpt-6-astra",
      input: 123,
      cached: 100,
      output: 17,
    })
  } finally {
    await harness.close(ctx)
    await rm(directory, { recursive: true, force: true })
  }
}, 15000)

it.each(["response.incomplete", "response.failed", "interrupted"])(
  "does not mark %s as completed and retains reported partial usage",
  async (terminal) => {
    const usage = new InferenceUsage(database()),
      route = resolveRoute("conversation")
    const models = createAgentModels(
      accountCredentials(async () => credential),
      {
        catalog: async () => catalog,
        onAttempt: () => usage.start(route, "turn", "conversation"),
      }
    )
    const result = await models.completeSimple(
      models.getModel("openai", route.model)!,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        reasoning: route.thinking === "off" ? undefined : route.thinking,
        maxRetries: 0,
        fetch: async () => response(route.model, "text", terminal),
      }
    )
    expect(result.stopReason).toBe("error")
    expect(usage.recent()[0]?.outcome).not.toBe("completed")
    expect(usage.recent()[0]?.input).toBe(
      terminal === "interrupted" ? null : 123
    )
  }
)

it("rejects unsupported efforts and API credentials before any inference request", async () => {
  let calls = 0
  for (const useApiKey of [false, true]) {
    const models = createAgentModels(
      accountCredentials(async () =>
        useApiKey ? { type: "api_key", key: "no-fallback" } : credential
      ),
      { catalog: async () => catalog }
    )
    const result = await models.completeSimple(
      models.getModel("openai", "gpt-6-astra")!,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      {
        reasoning: useApiKey ? "high" : "minimal",
        fetch: async () => {
          calls++
          return response("gpt-6-astra")
        },
      }
    )
    expect(result.stopReason).toBe("error")
  }
  expect(calls).toBe(0)
})

it("records an auth failure before provider dispatch and never hangs on a failed Activity write", async () => {
  const route = resolveRoute("conversation"),
    usage = new InferenceUsage(database())
  const unauthorized = createAgentModels(
    accountCredentials(async () => {
      throw new Error("Refresh authorization expired")
    }),
    { onAttempt: () => usage.start(route, "queued-turn", "conversation") }
  )
  const failed = await unauthorized.completeSimple(
    unauthorized.getModel("openai", route.model)!,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { reasoning: "medium" }
  )
  expect(failed.stopReason).toBe("error")
  expect(usage.recent()[0]).toMatchObject({
    outcome: "failed",
    turnId: "queued-turn",
    input: null,
  })
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      onAttempt: () => ({
        id: "synthetic",
        turnId: null,
        usage: () => {},
        end: () => {
          throw new Error("Synthetic SQLite failure")
        },
      }),
    }
  )
  const completed = await models.completeSimple(
    models.getModel("openai", route.model)!,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    { reasoning: "medium", fetch: async () => response(route.model) }
  )
  expect(completed.stopReason).toBe("stop")
}, 2000)
