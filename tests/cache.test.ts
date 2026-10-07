import { expect, it } from "vitest"
import { cacheUsage, memoryPayload, viewBlocks } from "../src/agent/cache"

it("splits on stable line ends and preserves every character", () => {
  const text =
    "<chat>\n" +
    Array.from({ length: 600 }, (_, i) => `${i}+1|${"é".repeat(220)}\n`).join(
      ""
    ) +
    "</chat>"
  const blocks = viewBlocks(text)
  expect(blocks).toHaveLength(4)
  expect(blocks.map((b) => b.text).join("")).toBe(text)
  expect(
    blocks
      .slice(0, 3)
      .every(
        (b) =>
          b.text.endsWith("\n") &&
          b.prompt_cache_breakpoint?.mode === "explicit"
      )
  ).toBe(true)
  expect(viewBlocks(text + "\nnew tail").slice(0, 3)).toEqual(
    blocks.slice(0, 3)
  )
})
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
        content: [
          { type: "input_text", text: "<chat>\n0+1|old\n</chat>" },
          { type: "input_text", text: "\nNew user request" },
        ],
      },
      reasoning,
      tool,
    ],
  })
})
it("captures numerical cache usage without retaining provider content", () => {
  expect(
    cacheUsage({
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
    cacheUsage({ type: "response.output_text.delta", delta: "private" })
  ).toBeUndefined()
})
