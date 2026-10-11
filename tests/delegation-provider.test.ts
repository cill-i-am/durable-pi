import { expect, it } from "vitest"
import { createAgentModels, accountCredentials } from "../src/agent/models"
import { credential, catalog, response } from "./inference-fixture"

it("guards actual installed Responses dispatch using native identity even when cache keys are shared", async () => {
  const observed: string[] = [],
    payloads: Record<string, unknown>[] = []
  let blocked = false
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      cacheKey: "synthetic-bot-cache",
      catalog: async () => catalog,
      beforeRequest: async (id) => {
        observed.push(id)
        if (blocked) throw new Error("Child request budget exhausted")
      },
    }
  )
  const provider = models.getProvider("openai")!
  models.setProvider({
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        fetch: async (_url, init) => {
          payloads.push(JSON.parse(String(init?.body)))
          return response(model.id)
        },
      }),
  })
  const model = models.getModel("openai", "gpt-6-luna")!
  const context = {
    messages: [
      {
        role: "user" as const,
        content: "Read the private draft.",
        timestamp: Date.now(),
      },
    ],
  }
  const options = {
    reasoning: "low" as const,
    sessionId: "native-child-session",
  }
  const first = await models.completeSimple(model, context, options)
  expect(first.stopReason).toBe("stop")
  expect(observed).toEqual(["native-child-session"])
  expect(payloads[0]!.prompt_cache_key).toBe("synthetic-bot-cache")
  blocked = true
  const second = await models.completeSimple(model, context, {
    ...options,
    cacheRetention: "none",
  })
  expect(second.stopReason).toBe("error")
  expect(payloads).toHaveLength(1)
  expect(observed).toEqual(["native-child-session", "native-child-session"])
})
it("does not consume a child dispatch after cancelled account validation", async () => {
  let validated!: () => void,
    release!: () => void,
    guarded = 0,
    dispatched = 0
  const entered = new Promise<void>((resolve) => {
      validated = resolve
    }),
    pending = new Promise<void>((resolve) => {
      release = resolve
    })
  const abort = new AbortController()
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      catalog: async () => {
        validated()
        await pending
        return catalog
      },
      beforeRequest: async () => {
        guarded++
      },
    }
  )
  const provider = models.getProvider("openai")!
  models.setProvider({
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        fetch: async () => {
          dispatched++
          return response(model.id)
        },
      }),
  })
  const running = models.completeSimple(
    models.getModel("openai", "gpt-6-luna")!,
    { messages: [{ role: "user", content: "Read", timestamp: Date.now() }] },
    { reasoning: "low", sessionId: "native-child", signal: abort.signal }
  )
  await entered
  abort.abort()
  release()
  await running
  expect(guarded).toBe(0)
  expect(dispatched).toBe(0)
})

it("keeps a recovered bot job's smaller account window and native identity without inventing an output cap", async () => {
  let floor: number | undefined = 65536
  const attempts: (string | undefined)[] = []
  const payloads: Record<string, unknown>[] = []
  const models = createAgentModels(
    accountCredentials(async () => credential),
    {
      contextWindow: () => 272000,
      workingContextFloor: () => floor,
      catalog: async () => catalog,
      onAttempt: (_model, _thinking, _purpose, provider) => {
        attempts.push(provider)
        return { usage: () => {}, end: () => {} }
      },
    }
  )
  const provider = models.getProvider("openai")!
  models.setProvider({
    ...provider,
    streamSimple: (model, context, options) =>
      provider.streamSimple(model, context, {
        ...options,
        fetch: async (_url, init) => {
          payloads.push(JSON.parse(String(init?.body)))
          return response(model.id)
        },
      }),
  })
  const small = models.getModel("openai", "gpt-6-luna")!
  expect(small.contextWindow).toBe(65536)
  await models.completeSimple(
    small,
    {
      messages: [
        {
          role: "user",
          content: "Summarize the supplied draft.",
          timestamp: Date.now(),
        },
      ],
    },
    { reasoning: "low", sessionId: "saved-bot-job-provider" }
  )
  expect(attempts).toEqual(["saved-bot-job-provider"])
  expect(payloads).toHaveLength(1)
  expect(payloads[0]!.max_output_tokens).toBeUndefined()
  floor = undefined
  const normal = models.getModel("openai", "gpt-6-luna")!
  expect(normal.contextWindow).toBe(272000)
  expect(small.maxTokens).toBe(normal.maxTokens)
})
