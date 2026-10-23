import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context"
import { Type } from "@earendil-works/pi-ai"
import { Harness, createRegistry, defineTool } from "@earendil-works/pi-durable"
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node"
import { Clock, Effect } from "effect"
import { expect, it, vi } from "vitest"

import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { submissionAttempt } from "../src/features/conversation/commands"
import { accountCredentials } from "../src/inference/adapters/credentials-pi"
import { resolveRoute } from "../src/inference/policy"
import { database } from "./database"
import { catalog, credential, response } from "./inference-fixture"
import { createAgentModels, expectModelDefect } from "./models-fixture"
import { usageFixture } from "./usage-fixture"

it("carries a composer override into native Pi Responses and preserves selection and completed actions across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-routing-")),
    path = join(directory, "pi.sqlite")
  const db = database(),
    store = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    }),
    usage = usageFixture(db)
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
  const turn = Effect.runSync(
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        store.admit(command, undefined, [], route, {
          discoveryDeadline: now + 60_000,
        })
      )
    )
  ).turn
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
          return { output: [{ type: "text", text: "result saved once" }] }
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
    Effect.runSync(store.setSettings({ model: "gpt-6-luna", thinking: "low" }))
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
    expect(telemetry).toHaveLength(payloads.length * 2)
    await Promise.all(telemetry)
    expect(
      Effect.runSync(
        new ConversationStore(db, { model: "gpt-6-luna", thinking: "low" }).get(
          turn.id
        )
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
    const usage = usageFixture(database()),
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
    usage = usageFixture(database())
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
  const defect = new Error("Synthetic SQLite failure")
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      onAttempt: () => ({
        id: "synthetic",
        turnId: null,
        usage: () => {},
        end: () => {
          throw defect
        },
      }),
    }
  )
  expectModelDefect(models, defect)
  await expect(
    models.completeSimple(
      models.getModel("openai", route.model)!,
      { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
      { reasoning: "medium", fetch: async () => response(route.model) }
    )
  ).rejects.toMatchObject({
    reasons: expect.arrayContaining([
      expect.objectContaining({ _tag: "Die", defect }),
    ]),
  })
}, 2000)

it.each(["short", "none"] as const)(
  "persists provider milestones and excludes %s compaction from visible-text tracing",
  async (cacheRetention) => {
    const firstText = vi.fn()
    const usage = usageFixture(database())
    const models = createAgentModels(
      accountCredentials(async () => credential),
      {
        catalog: async () => catalog,
        onFirstText: firstText,
        onAttempt: () => ({
          ...usage.start(
            resolveRoute("conversation"),
            "timed-turn",
            "conversation"
          ),
          sessionId: "native-conversation",
        }),
      }
    )
    const model = models.getModel("openai", "gpt-6.1-sol")!
    const raw = await response(model.id).text()
    const events = raw
      .split("\n")
      .filter((line) => line.startsWith("data: {"))
      .map((line) => JSON.parse(line.slice(6)))
    const added = events.find(
      (event) => event.type === "response.output_item.added"
    )
    added.item.content = [{ type: "output_text", text: "", annotations: [] }]
    events.splice(
      2,
      0,
      {
        type: "response.content_part.added",
        output_index: 0,
        content_index: 0,
        part: { type: "output_text", text: "", annotations: [] },
      },
      {
        type: "response.output_text.delta",
        item_id: "msg_one",
        output_index: 0,
        content_index: 0,
        delta: "Saved and verified.",
      }
    )
    const result = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            content: "Private prompt must not be in timings",
            timestamp: 0,
          },
        ],
      },
      {
        reasoning: "medium",
        sessionId: "timing-test",
        cacheRetention,
        fetch: async () =>
          new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join("") + "data: [DONE]\n\n",
            { headers: { "content-type": "text/event-stream" } }
          ),
      }
    )
    expect(result.stopReason).toBe("stop")
    const attempt = usage.recent()[0]!
    expect(attempt.outcome).toBe("completed")
    const timings = attempt.timings!
    expect(timings.fetchStartMs).toBeGreaterThanOrEqual(0)
    expect(timings.responseHeadersMs).toBeGreaterThanOrEqual(
      timings.fetchStartMs!
    )
    expect(timings.firstEventMs).toBeGreaterThanOrEqual(
      timings.responseHeadersMs!
    )
    expect(timings.firstTextMs).toBeGreaterThanOrEqual(timings.firstEventMs!)
    expect(
      Object.values(timings).every((value) => typeof value === "number")
    ).toBe(true)
    expect(JSON.stringify(attempt)).not.toContain("Private prompt")
    expect(JSON.stringify(attempt)).not.toContain(credential.access)
    if (cacheRetention === "short")
      expect(firstText).toHaveBeenCalledExactlyOnceWith(
        "timed-turn",
        attempt.id,
        "native-conversation"
      )
    else expect(firstText).not.toHaveBeenCalled()
  }
)
