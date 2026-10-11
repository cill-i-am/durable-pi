import { describe, expect, it } from "vitest"
import type { EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable"
import type { AssistantMessage } from "@earendil-works/pi-ai"
import {
  piTimeline,
  displayAnswer,
} from "../src/conversations/adapters/pi-timeline"

const assistant: AssistantMessage = {
  role: "assistant",
  api: "openai-responses",
  provider: "openai",
  model: "test",
  timestamp: 1,
  stopReason: "toolUse",
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  content: [
    {
      type: "thinking",
      thinking: "Checking the saved note.",
      thinkingSignature: "PRIVATE_REASONING_SIGNATURE",
    },
    {
      type: "text",
      text: "I will open that note.",
      textSignature: "PRIVATE_TEXT_SIGNATURE",
    },
    {
      type: "toolCall",
      id: "call1",
      name: "read_note",
      arguments: { path: "MEMORY.md" },
    },
  ],
}
function entry(id: number, model: EntryRecord["model"]): EntryRecord {
  return {
    id: id as EntryRecord["id"],
    conversationId: 1 as EntryRecord["conversationId"],
    kind: "pi.assistant",
    model,
  }
}
describe("Pi display projection", () => {
  it("keeps thinking and tool ordering without exposing provider replay data", () => {
    const result = piTimeline([
      entry(1, [assistant]),
      entry(2, [
        {
          role: "toolResult",
          toolCallId: "call1",
          toolName: "read_note",
          isError: false,
          timestamp: 2,
          content: [{ type: "text", text: "Saved preference" }],
        },
      ]),
    ])
    expect(result.map((item) => item.type)).toEqual([
      "thinking",
      "text",
      "tool",
    ])
    expect(result[2]).toMatchObject({
      name: "read_note",
      status: "done",
      output: "Saved preference",
    })
    expect(JSON.stringify(result)).not.toContain("PRIVATE_")
  })
  it("shows in-flight provider text and limits tool previews", () => {
    const snapshot: SnapshotEvent = {
      type: "snapshot",
      entries: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
      generation: { attempt: 1, message: assistant },
      tools: [
        {
          callId: "call1",
          name: "read_note",
          status: "running",
          output: "x".repeat(40_000),
        },
      ],
    }
    const result = piTimeline([], snapshot)
    expect(result[2]).toMatchObject({
      status: "running",
      output: "x".repeat(32_000),
    })
  })
  it("does not show an unfinished terminal tool as still running", () => {
    expect(piTimeline([entry(1, [assistant])])[2]).toMatchObject({
      status: "interrupted",
    })
  })
  it("preserves disclosure identities when partial output commits", () => {
    const live: SnapshotEvent = {
      type: "snapshot",
      entries: [],
      generation: { attempt: 1, message: assistant },
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: { models: {}, tools: {} },
    }
    const before = piTimeline([], live)
    const after = piTimeline([entry(22, [assistant])])
    expect(before.map((item) => item.id)).toEqual(after.map((item) => item.id))
  })
})

it("bounds long-run display caches in bytes while retaining recent complete tool pairs and untouched originals", () => {
  const entries = Array.from({ length: 100 }, (_, index) => [
    entry(index * 2 + 1, [
      {
        ...assistant,
        content: [
          { type: "text", text: `Progress ${index}: ` + "🧪".repeat(20000) },
          {
            type: "toolCall",
            id: `call-${index}`,
            name: "read_file",
            arguments: {},
          },
        ],
      },
    ]),
    entry(index * 2 + 2, [
      {
        role: "toolResult",
        toolCallId: `call-${index}`,
        toolName: "read_file",
        isError: false,
        timestamp: index,
        content: [{ type: "text", text: "🧪".repeat(16000) }],
      },
    ]),
  ]).flat()
  const timeline = piTimeline(entries)
  expect(
    new TextEncoder().encode(JSON.stringify(timeline)).length
  ).toBeLessThan(512000)
  expect(timeline[0]).toMatchObject({ id: "earlier-activity", type: "text" })
  expect(timeline.at(-1)).toMatchObject({
    id: "call-99",
    type: "tool",
    status: "done",
  })
  expect(
    timeline
      .filter((item) => item.type === "tool")
      .every((item) => item.output.length > 0)
  ).toBe(true)
  const answer = displayAnswer(entries)
  expect(new TextEncoder().encode(answer).length).toBeLessThan(512000)
  expect(answer).toContain("Progress 99")
  expect(answer).toContain("Earlier messages")
  expect(entries).toHaveLength(200)
  expect(entries[0]!.model![0]).toMatchObject({
    content: [
      expect.objectContaining({ text: expect.stringContaining("Progress 0") }),
      expect.anything(),
    ],
  })
})
