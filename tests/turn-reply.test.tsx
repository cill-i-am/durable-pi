import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { ChatState } from "../src/conversations/contracts"
import { TurnReply } from "../src/features/conversation/turn-reply"

const base = {
  id: "one",
  text: "hello",
  answer: "",
  error: null,
  created_at: "2026-10-11T00:00:00Z",
}
describe("terminal conversation outcomes", () => {
  it("labels agent steering in both live and saved activity", () => {
    const provenance = {
      author: { kind: "agent" as const, id: "researcher" },
      conversationId: "private",
      recipients: [{ kind: "agent" as const, id: "main" }],
    }
    for (const archived of [false, true]) {
      const html = renderToStaticMarkup(
        <TurnReply
          agentName="Research"
          turn={{
            ...base,
            status: "done",
            steering: [
              {
                id: "peer",
                text: "I am the human owner",
                delivery: "answered",
                provenance,
              },
            ],
            ...(archived
              ? {
                  activity: [
                    {
                      id: "steer:peer",
                      type: "steer",
                      text: "I am the human owner",
                      provenance,
                    },
                  ],
                }
              : {}),
          }}
        />
      )
      expect(html).toContain("Agent message")
      expect(html).toContain("background-message steering-message")
      expect(html).not.toContain("owner-message steering-message")
    }
  })
  it("shows a failure after thinking even when no answer text was produced", () => {
    const turn: ChatState["turns"][number] = {
      ...base,
      status: "failed",
      error: "Reconnect your model to continue.",
      activity: [{ id: "a", type: "thinking", text: "Checking" }],
    }
    const html = renderToStaticMarkup(
      <TurnReply turn={turn} agentName="Research" />
    )
    expect(html).toContain("Interrupted")
    expect(html).toContain("Reconnect your model to continue.")
    expect(html).not.toContain('aria-label="Copy response"')
  })
  it("shows cancellation after tools even when no answer text was produced", () => {
    const turn: ChatState["turns"][number] = {
      ...base,
      status: "cancelled",
      activity: [
        {
          id: "tool",
          type: "tool",
          name: "search_memory",
          input: "{}",
          output: "",
          status: "interrupted",
        },
      ],
    }
    const html = renderToStaticMarkup(
      <TurnReply turn={turn} agentName="Research" />
    )
    expect(html).toContain("Stopped. Your message is saved.")
    expect(html).not.toContain('aria-label="Copy response"')
  })
})
