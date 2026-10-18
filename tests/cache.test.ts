import { expect, it } from "vitest"

import {
  memoryPayload,
  viewChunks,
} from "../src/inference/adapters/payload-openai"
import { providerUsage } from "../src/inference/adapters/usage-openai"

it("preserves encrypted reasoning/tool replay and separates legacy user text", () => {
  const reasoning = {
      type: "reasoning",
      id: "r",
      encrypted_content: "synthetic-encrypted",
    },
    tool = { type: "function_call_output", call_id: "t", output: "ok" }
  const result = memoryPayload({
    store: true,
    reasoning: { effort: "medium" },
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<chat>\n0+1|old\n</chat>\nNew user request",
          },
        ],
      },
      reasoning,
      tool,
    ],
  })
  expect(result).toMatchObject({
    store: false,
    reasoning: { effort: "medium", context: "all_turns" },
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "<chat>\n0+1|old\n</chat>" }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: "\nNew user request" }],
      },
      reasoning,
      tool,
    ],
  })
})
it("captures numerical cache usage without retaining provider content", () => {
  expect(
    providerUsage({
      type: "response.completed",
      response: {
        id: "r",
        model: "m",
        output: ["private"],
        usage: {
          input_tokens: 2000,
          input_tokens_details: { cached_tokens: 1800 },
          output_tokens: 20,
        },
      },
    })
  ).toEqual({ id: "r", model: "m", input: 2000, cached: 1800, output: 20 })
  expect(
    providerUsage({ type: "response.output_text.delta", delta: "private" })
  ).toBeUndefined()
})

it("keeps native summary requests uncached and ordinary OptChat prompts cacheable on the subscription transport", async () => {
  const { createAgentModels } = await import("./models-fixture")
  const { accountCredentials } =
    await import("../src/inference/adapters/credentials-pi")
  const models = createAgentModels(
    accountCredentials(async () => ({
      type: "oauth",
      access: "synthetic-local-access",
      refresh: "synthetic-local-refresh",
      clientId: "local-fixture",
      expires: Date.now() + 3600000,
    })),
    { cacheKey: "stable-bot-key" }
  )
  const model = models.getModel("openai", "gpt-6.1-sol")!
  expect(model.contextWindow).toBe(272000)
  expect(model.maxTokens).toBe(128000)
  const payloads: Record<string, unknown>[] = []
  const fetch = async (_url: RequestInfo | URL, init?: RequestInit) => {
    payloads.push(JSON.parse(String(init?.body)))
    return new Response(
      JSON.stringify({
        error: { message: "Synthetic transport; no network request made" },
      }),
      { status: 400, headers: { "content-type": "application/json" } }
    )
  }
  for (const cacheRetention of [undefined, "none"] as const) {
    const result = await models.completeSimple(
      model,
      {
        messages: [
          {
            role: "user",
            timestamp: 1,
            content: `<chat>\n${"old entry\n".repeat(6000)}</chat>\nCurrent request`,
          },
        ],
      },
      {
        fetch,
        cacheRetention,
        maxRetries: 0,
        reasoning: "medium",
        maxTokens: 1600,
      }
    )
    expect(result.stopReason).toBe("error")
  }
  expect(payloads).toHaveLength(2)
  expect(payloads[0]!.prompt_cache_key).toBe("stable-bot-key")
  expect(payloads[1]!.prompt_cache_key).toBeUndefined()
  for (const payload of payloads) {
    expect(payload.store).toBe(false)
    expect(payload.context_management).toBeUndefined()
    expect(payload.max_output_tokens).toBeUndefined()
    expect(JSON.stringify(payload)).not.toContain("prompt_cache_breakpoint")
    const input = payload.input as { content: { text: string }[] }[]
    const messages = input.map((item) => item.content[0]!.text)
    expect(messages.at(-1)).toBe("\nCurrent request")
    expect(
      messages
        .slice(0, -1)
        .map((text) => text.slice(7, -8))
        .join("")
    ).toBe("old entry\n".repeat(6000).slice(0, -1))
    expect(payload.reasoning).toMatchObject({ context: "all_turns" })
  }
})

it("keeps native cache boundaries stable as the context grows, without losing Unicode lines", () => {
  const original = Array.from(
    { length: 500 },
    (_, i) => `${i}+1|Saved €42.75 🍀 中\n`
  ).join("")
  const before = viewChunks(original)
  expect(before.join("")).toBe(original)
  expect(viewChunks(original + "500+0|user: New message").slice(0, -1)).toEqual(
    before.slice(0, -1)
  )
  expect(before.every((chunk) => chunk.endsWith("\n"))).toBe(true)
  expect(viewChunks("🍀".repeat(4_001)).join("")).toBe("🍀".repeat(4_001))
})
it("keeps current request attachments together after the working-context messages", () => {
  const image = {
    type: "input_image",
    image_url: "data:image/png;base64,synthetic",
  }
  const result = memoryPayload({
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<chat>\n0+1|old\n</chat>\nInspect this image",
          },
          image,
        ],
      },
    ],
  })
  expect(result.input).toEqual([
    {
      role: "user",
      content: [{ type: "input_text", text: "<chat>\n0+1|old\n</chat>" }],
    },
    {
      role: "user",
      content: [{ type: "input_text", text: "\nInspect this image" }, image],
    },
  ])
})
