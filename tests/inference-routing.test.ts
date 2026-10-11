import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { createModels } from "@earendil-works/pi-ai/models"
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai"
import { reconcileCatalog, discoverCatalog } from "../src/inference/catalog"
import {
  resolveRoute,
  validateRoute,
  ModelUnavailable,
} from "../src/inference/policy"
import { ConversationStore } from "../src/conversations/adapters/sqlite-turns"
import { InferenceUsage } from "../src/inference/usage"
import { submissionAttempt } from "../src/features/conversation/commands"
import { database } from "./database"

export const account = {
  models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"].map((slug) => ({
    slug,
    display_name: slug,
    visibility: "list",
    supported_in_api: true,
    context_window: 272000,
    input_modalities: ["text", "image"],
    supported_reasoning_levels: ["low", "medium", "high", "xhigh"].map(
      (effort) => ({ effort })
    ),
  })),
}
const models = createModels()
models.setProvider(openaiProvider())
export const catalog = reconcileCatalog(account, models.getModels("openai"))

describe("job model routing", () => {
  it("uses explicit profile, then agent job setting, then application defaults without classifying prose", () => {
    expect(resolveRoute("conversation")).toMatchObject({
      model: "gpt-6.1-sol",
      thinking: "medium",
      reason: "application default",
    })
    expect(resolveRoute("planning")).toMatchObject({
      model: "gpt-6-astra",
      thinking: "high",
    })
    expect(
      resolveRoute("conversation", { model: "gpt-6-luna", thinking: "medium" })
    ).toMatchObject({ model: "gpt-6-luna", reason: "agent setting" })
    expect(
      resolveRoute(
        "conversation",
        { model: "gpt-6-luna", thinking: "medium" },
        "deep"
      )
    ).toMatchObject({
      model: "gpt-6-astra",
      thinking: "high",
      reason: "explicit override",
    })
    expect(resolveRoute("memory")).toMatchObject({
      model: "gpt-6-luna",
      thinking: "medium",
    })
  })
  it("requires account access, supported effort, modalities and tool capability without clamping", () => {
    expect(
      validateRoute(resolveRoute("conversation"), catalog).contextWindow
    ).toBe(272000)
    expect(() =>
      validateRoute({ model: "gpt-6-luna", thinking: "off" }, catalog)
    ).toThrow(ModelUnavailable)
    const narrowed = reconcileCatalog(
      {
        models: [
          {
            ...account.models[0],
            input_modalities: ["text"],
            supports_tools: false,
            context_window: 16000,
          },
        ],
      },
      models.getModels("openai")
    )
    expect(() => validateRoute(resolveRoute("conversation"), narrowed)).toThrow(
      /not available/i
    )
    expect(() => validateRoute(resolveRoute("labels"), narrowed, true)).toThrow(
      /images/
    )
    expect(() => validateRoute(resolveRoute("labels"), narrowed)).toThrow(
      /tools/
    )
    expect(
      validateRoute(resolveRoute("labels"), narrowed, false, false)
        .contextWindow
    ).toBe(16000)
    const unknown = reconcileCatalog(
      { models: [{ ...account.models[0], slug: "future" }] },
      models.getModels("openai")
    )
    expect(unknown.models[0]?.unavailable).toContain("installed")
  })
  it("does not leak or fall back between accounts, API keys, malformed catalogs or discovery failures", async () => {
    let requests = 0
    const fetcher = async (_: RequestInfo | URL, options?: RequestInit) => {
      requests++
      expect(new Headers(options?.headers).get("authorization")).toBe(
        "Bearer owner-a"
      )
      return Response.json(account)
    }
    const credential = {
      type: "oauth" as const,
      access: "owner-a",
      refresh: "synthetic",
      expires: Date.now() + 3600000,
      clientId: "test",
    }
    expect(
      (
        await Effect.runPromise(
          discoverCatalog(credential, models.getModels("openai"), fetcher)
        )
      ).models[0]?.id
    ).toBe("gpt-6-luna")
    await expect(
      Effect.runPromise(
        discoverCatalog(
          { type: "api_key", key: "no-fallback" },
          models.getModels("openai"),
          fetcher
        )
      )
    ).rejects.toThrow(/API-key fallback/)
    expect(requests).toBe(1)
    await expect(
      Effect.runPromise(
        discoverCatalog(
          credential,
          models.getModels("openai"),
          async () => new Response(null, { status: 401 })
        )
      )
    ).rejects.toThrow(/Reconnect/)
    await expect(
      Effect.runPromise(
        discoverCatalog(credential, models.getModels("openai"), async () =>
          Response.json({ data: [] })
        )
      )
    ).rejects.toThrow(/verify/)
    const other = reconcileCatalog({ models: [] }, models.getModels("openai"))
    expect(other.models.every((m) => m.unavailable)).toBe(true)
    expect(catalog.models.every((m) => !m.unavailable)).toBe(true)
  })
  it("pins UI intent through admission, replay, steering, changed defaults and restart; isolates bot defaults", () => {
    const db = database(),
      store = new ConversationStore(db, {
        model: "gpt-6.1-sol",
        thinking: "medium",
      })
    store.setJobSetting("planning", { model: "gpt-6.1-sol", thinking: "high" })
    const command = submissionAttempt(null, "design it", "followUp", [], "deep")
    const route = {
      ...resolveRoute("conversation", undefined, command.profile),
      contextWindow: 272000,
    }
    const root = store.admit(command, undefined, [], route).turn
    store.setSettings({ model: "gpt-6-luna", thinking: "low" })
    expect(store.admit(command).turn.routing).toEqual(route)
    expect(() => store.admit({ ...command, profile: "fast" })).toThrow(
      /another message/
    )
    expect(
      submissionAttempt(command, "design it", "steer", [], "fast")
    ).toEqual(command)
    const restored = new ConversationStore(db, {
      model: "new-app-default",
      thinking: "low",
    })
    expect(restored.get(root.id)?.model).toBe("gpt-6-astra")
    const steer = restored.admit({
      operationId: crypto.randomUUID(),
      text: "keep mobile support",
      mode: "steer",
    }).turn
    expect(steer.routing).toMatchObject({ ...route, reason: "active run" })
    expect(() =>
      restored.admit({
        operationId: crypto.randomUUID(),
        text: "steer",
        mode: "steer",
        profile: "fast",
      })
    ).toThrow(/Steering keeps/)
    const other = new ConversationStore(database(), {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
    expect(other.jobSetting("planning")).toBeUndefined()
    expect(restored.jobSetting("planning")?.model).toBe("gpt-6.1-sol")
    expect(
      restored.admit(submissionAttempt(null, "next", "followUp")).turn.model
    ).toBe("gpt-6-luna")
  })
  it("recovers orphaned activity without retrying execution or inventing usage", () => {
    const db = database(),
      usage = new InferenceUsage(db)
    const observation = usage.start(
      resolveRoute("conversation"),
      "turn-a",
      "conversation"
    )
    observation.usage({
      id: "response-a",
      model: "gpt-6.1-sol",
      input: 123,
      cached: 100,
      output: 17,
    })
    const recovered = new InferenceUsage(db)
    expect(recovered.recent()[0]).toMatchObject({
      outcome: "interrupted",
      input: 123,
      cached: 100,
      output: 17,
      turnId: "turn-a",
    })
    const second = recovered.start(resolveRoute("labels"), null, "memory")
    second.end("failed", "Connection failed")
    expect(recovered.recent()[0]?.input).toBeNull()
    expect(new InferenceUsage(database()).recent()).toEqual([])
  })
})

it("keeps legacy model pins and versions every job setting update", () => {
  const db = database(),
    store = new ConversationStore(db, {
      model: "gpt-6.1-sol",
      thinking: "medium",
    })
  const turn = store.admit(submissionAttempt(null, "old task", "followUp")).turn
  db.run(
    "UPDATE chat_turns SET routing=NULL,model='gpt-6-astra',thinking='high',status='failed' WHERE id=?",
    turn.id
  )
  store.setSettings({ model: "gpt-6-luna", thinking: "low" })
  const before = store.selection().settingsRevision
  store.setJobSetting("planning", { model: "gpt-6.1-sol", thinking: "high" })
  expect(store.selection().settingsRevision).toBe(before + 1)
  const retry = store.admit({
    operationId: crypto.randomUUID(),
    text: turn.text,
    retryOf: turn.id,
  }).turn
  expect(retry.routing).toMatchObject({
    model: "gpt-6-astra",
    thinking: "high",
    reason: "legacy run",
    policyVersion: "legacy",
  })
})
