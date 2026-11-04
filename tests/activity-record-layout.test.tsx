import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ActivityConversation } from "../src/activity/contracts"
import { homeAgentId } from "../src/agents/domain"
import { ActivityRecord } from "../src/features/activity/activity-record"

const query = vi.hoisted(() => ({
  read: vi.fn(),
  data: null as ActivityConversation | null,
  error: "",
}))
vi.mock("../src/features/activity/use-activity-query", () => ({
  useActivityQuery: (options: unknown) => {
    query.read(options)
    return { data: query.data, error: query.error, refresh: vi.fn() }
  },
}))
const entry = {
  agent: { id: homeAgentId, name: "Personal assistant" },
  reference: "saved-turn",
}
const render = (active = true, at?: string) =>
  renderToStaticMarkup(
    <ActivityRecord
      entry={{ ...entry, at }}
      active={active}
      onClose={() => {}}
      onOpenBot={() => {}}
    />
  )
beforeEach(() => {
  query.read.mockClear()
  query.error = ""
  query.data = {
    source: "user",
    id: entry.reference,
    text: "Original task",
    answer: "Saved answer",
    status: "done",
    error: null,
    activity: [],
  }
})
describe("saved activity in its owning pane", () => {
  it("presents a historical request and reply without live execution controls or a desktop dialog", () => {
    const html = render(true, "2026-10-30T10:43:00.000Z")
    expect(html).toContain('aria-label="Saved conversation"')
    expect(html).toContain("Back to activity")
    expect(html).toContain("Original task")
    expect(html).toContain("Saved reply")
    expect(html).toContain("Saved answer")
    expect(html).toContain("Open assistant")
    expect(html).toContain("Personal assistant")
    expect(html).toContain('dateTime="2026-10-30T10:43:00.000Z"')
    expect(html).not.toContain('role="dialog"')
    for (const action of ["Approve", "Stop", "Retry current work"])
      expect(html).not.toContain(action)
  })
  it("gates only the read observer when its retained tab becomes inactive", () => {
    render(false)
    expect(query.read).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
        key: JSON.stringify(["record", homeAgentId, entry.reference]),
      })
    )
  })
  it("states unavailable or invalid times honestly and keeps recovery beside an unavailable record", () => {
    expect(render()).toContain("Recorded time unavailable")
    expect(render(true, "invalid")).toContain("Recorded time unavailable")
    query.data = null
    query.error = "This conversation is unavailable."
    const html = render()
    expect(html).toContain("Recorded time unavailable")
    expect(html).toContain("This conversation is unavailable.")
    expect(html).toContain("Reconnect")
    expect(html).toContain("Back to activity")
    expect(html).not.toContain("Saved answer")
  })
})
