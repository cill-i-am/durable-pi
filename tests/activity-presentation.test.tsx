import { StreamProcessor } from "@tanstack/ai-client"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import {
  chatMessages,
  conversationView,
  messageEvents,
} from "../src/conversations/adapters/tanstack"
import type { ChatState, TimelineItem } from "../src/conversations/contracts"
import {
  activitySections,
  activitySource,
  toolPresentation,
  workPresentation,
  type ToolItem,
} from "../src/features/conversation/activity-presentation"
import { TurnActivity } from "../src/features/conversation/turn-activity"
import { parseAgentId, workspaceDestination } from "../src/navigation/workspace"

const tool = (
  name: string,
  output = "",
  status: ToolItem["status"] = "done"
): ToolItem => ({
  id: "call-1",
  type: "tool",
  name,
  input: "{}",
  output,
  status,
})
const page = {
  url: "https://example.com/guide",
  title: "Visitor guide",
  links: [
    { text: "Tickets", url: "https://example.com/tickets" },
    { text: "Duplicate", url: "https://example.com/tickets" },
    { text: "Not a navigation", url: "javascript:alert(1)" },
    { text: "Credentials", url: "https://secret:password@example.com/" },
  ],
}
const thought: TimelineItem = {
  id: "assistant:0:0",
  type: "thinking",
  text: "Check the visitor guide.",
}

describe("recorded activity presentation", () => {
  it("keeps text, steering and live editable results outside work disclosures without changing records", () => {
    const items: TimelineItem[] = [
      thought,
      tool("browser_read"),
      { id: "text", type: "text", text: "A guide" },
      { id: "steer", type: "steer", text: "Keep Friday free" },
      { ...tool("create_checklist", '{"objectId":"saved"}'), id: "object" },
      { ...tool("publish_app", '{"appId":"saved"}'), id: "app" },
    ]
    const original = JSON.stringify(items)
    const sections = activitySections(items)
    expect(sections.map((item) => item.type)).toEqual([
      "work",
      "text",
      "steer",
      "work",
      "inline",
      "work",
      "inline",
    ])
    expect(sections.map((item) => item.id)).toEqual([
      thought.id,
      "text",
      "steer",
      "object",
      "inline:object",
      "app",
      "inline:app",
    ])
    expect(JSON.stringify(items)).toBe(original)
  })

  it("validates known browser output, deduplicates page links and never infers visits from discovered links", () => {
    const display = toolPresentation(tool("browser_read", JSON.stringify(page)))
    expect(display.sources.map((source) => source.href)).toEqual([
      page.url,
      "https://example.com/tickets",
    ])
    expect(display.destination).toEqual({
      label: "Open current browser",
      view: { panel: "browser" },
    })
    const html = renderToStaticMarkup(
      <TurnActivity items={[tool("browser_read", JSON.stringify(page))]} />
    )
    expect(html).toContain("Completed tool calls")
    expect(html).not.toContain("Read Tickets")
    for (const item of [
      tool("browser_read", JSON.stringify(page), "error"),
      tool("browser_read", JSON.stringify(page), "interrupted"),
      tool("browser_read", JSON.stringify(page), "running"),
      tool("remote_browser_search", JSON.stringify(page)),
      tool("browser_read", JSON.stringify(page).slice(0, 50)),
    ]) {
      expect(toolPresentation(item).sources).toEqual([])
      expect(toolPresentation(item).destination).toBeUndefined()
    }
  })

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///private",
    "https://user:pass@example.com",
    "not a url",
  ])("rejects unsafe source %s", (url) =>
    expect(activitySource(url)).toBeNull()
  )

  it("requests only the public HTTPS origin's favicon, without page paths or query data", () => {
    expect(
      activitySource(
        "https://www.met.ie/forecasts/munster?query=private#detail"
      )?.favicon
    ).toBe("https://www.met.ie/favicon.ico")
    for (const url of [
      "http://www.met.ie/",
      "https://www.met.ie:8443/",
      "https://localhost/",
      "https://127.0.0.1/",
      "https://[::1]/",
      "https://weather.internal/",
    ])
      expect(activitySource(url)?.favicon).toBeNull()
  })

  it("keeps source names accessible and favicon images decorative with no referrer", () => {
    const html = renderToStaticMarkup(
      <TurnActivity
        status="running"
        items={[tool("browser_read", JSON.stringify(page))]}
      />
    )
    expect(html).toContain('src="https://example.com/favicon.ico"')
    expect(html).toContain('alt=""')
    expect(html).toContain('referrerPolicy="no-referrer"')
    expect(html).toContain('loading="lazy"')
    expect(html).toContain("Visitor guide")
    expect(html).not.toContain("favicon.ico?query")
  })

  it("links namespaced saved receipts through the owning bot's canonical route, including failed execution", () => {
    for (const [name, id, panel] of [
      ["run_command", "command:task-one", "terminal"],
      ["run_code", "code:task-two", "code"],
    ] as const) {
      const display = toolPresentation(
        tool(name, JSON.stringify({ id, status: "failed" }), "error")
      )
      expect(display.destination?.view).toEqual({ panel, item: id })
      const route = workspaceDestination(
        parseAgentId("11111111-1111-4111-8111-111111111111"),
        display.destination!.view
      )
      expect(route.params).toEqual({
        agentId: "11111111-1111-4111-8111-111111111111",
        panel,
        itemId: id,
      })
      expect(
        toolPresentation(
          tool(
            name,
            JSON.stringify({ id: "another:receipt", status: "succeeded" })
          )
        ).destination
      ).toBeUndefined()
      expect(
        toolPresentation(
          tool(
            name,
            JSON.stringify({ id: id + "/../other", status: "succeeded" })
          )
        ).destination
      ).toBeUndefined()
    }
  })

  it("keeps archive searches distinct from web searches and carries the recorded query into Memory", () => {
    const item = {
      ...tool(
        "search_memory",
        JSON.stringify([
          { id: 2, kind: "user", date: "2026-10-13", preview: "A correction" },
        ])
      ),
      input: JSON.stringify({ query: "Friday & Saturday" }),
    }
    expect(toolPresentation(item).destination).toEqual({
      label: "Memory · 1 match",
      view: { panel: "memory", tab: "history", query: "Friday & Saturday" },
    })
    expect(
      toolPresentation({ ...item, output: '{"count":10}' }).destination
    ).toBeUndefined()
    expect(
      toolPresentation({ ...item, input: "{}" }).destination
    ).toBeUndefined()
  })

  it("uses run/access state for approval waits, cancellation, stopping and recovery instead of an animated stale tool", () => {
    const items = [tool("browser_open", "", "running")]
    expect(workPresentation(items, "running", true, false)).toMatchObject({
      label: "Browsing",
      active: true,
    })
    expect(workPresentation(items, "running", true, true)).toMatchObject({
      label: "Waiting for approval",
      active: false,
      defaultOpen: true,
    })
    expect(workPresentation(items, "stopping", true, true)).toMatchObject({
      label: "Stopping…",
      active: false,
    })
    expect(workPresentation(items, "cancelled", true, true)).toMatchObject({
      label: "Stopped",
      active: false,
      paused: true,
    })
    const stopped = renderToStaticMarkup(
      <TurnActivity items={items} status="cancelled" />
    )
    expect(stopped).toContain("Stopped")
    expect(stopped).not.toContain(">Running<")
    expect(workPresentation(items, "failed", true, false)).toMatchObject({
      label: "Interrupted",
      active: false,
      attention: true,
    })
    expect(workPresentation(items, "running", false, true)).toMatchObject({
      label: "Waiting for approval",
      active: false,
    })
    expect(workPresentation(items, "done", false, false)).toMatchObject({
      label: "Interrupted",
      active: false,
      attention: true,
    })
    expect(
      workPresentation(
        [
          tool("browser_open", "recorded failure", "error"),
          { ...tool("browser_read"), id: "recovery" },
        ],
        "done",
        false,
        false
      )
    ).toMatchObject({
      label: "Activity · 1 failed",
      attention: true,
      active: false,
    })
    expect(
      workPresentation([tool("browser_read")], "running", false, false)
    ).toMatchObject({ label: "Completed tool calls", active: false })
  })

  it("projects actual TanStack streaming, settled snapshots and reconnects without new requests or losing IDs and results", () => {
    const metadata = {
      model: "test",
      connected: true,
      memory: { messages: 0, summaries: 0, ready: true, notes: [] },
    }
    const live: ChatState["turns"][number] = {
      id: "turn",
      text: "Read the guide",
      status: "running",
      answer: "",
      error: null,
      created_at: "2026-10-13T00:00:00Z",
      activity: [thought, tool("browser_open", "", "running")],
    }
    const processor = new StreamProcessor()
    const before = chatMessages([live])
    messageEvents(undefined, before).forEach((event) =>
      processor.processChunk(event)
    )
    const initial = conversationView(processor.getMessages(), metadata)
      .turns[0]!
    const done = {
      ...live,
      status: "done" as const,
      answer: "Friday stays free.",
      activity: [
        thought,
        tool("browser_open", JSON.stringify(page)),
        { id: "steer", type: "steer" as const, text: "Keep Friday free" },
        { id: "answer", type: "text" as const, text: "Friday stays free." },
      ],
    }
    const after = chatMessages([done])
    messageEvents(before, after).forEach((event) =>
      processor.processChunk(event)
    )
    const settled = conversationView(processor.getMessages(), metadata)
      .turns[0]!
    expect(activitySections(initial.activity!)[0]!.id).toBe(
      activitySections(settled.activity!)[0]!.id
    )
    expect(settled.activity).toEqual(done.activity)
    const restored = new StreamProcessor()
    messageEvents(undefined, after).forEach((event) =>
      restored.processChunk(event)
    )
    expect(conversationView(restored.getMessages(), metadata).turns[0]).toEqual(
      settled
    )
    expect(
      toolPresentation(settled.activity![1] as ToolItem).sources[0]?.href
    ).toBe(page.url)
  })
})
