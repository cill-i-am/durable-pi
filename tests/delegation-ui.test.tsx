import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { Group } from "../src/delegation/contracts"
import { DelegationGroup } from "../src/features/activity/delegated-work"
import { resolveRoute } from "../src/inference/policy"

const group: Group = {
  id: 1,
  turnId: "turn",
  conversationId: 1,
  objective: "Prepare a guide",
  route: resolveRoute("conversation"),
  createdAt: 0,
  deadline: 2000000000000,
  status: "working",
  children: [
    {
      id: 1,
      name: "Research",
      task: "Read the guide",
      tools: ["read_file"],
      status: "working",
      answer: "",
      requests: 1,
      inputTokens: null,
      outputTokens: null,
      steering: [],
      error: null,
    },
  ],
}
const render = (value: Group) =>
  renderToStaticMarkup(<DelegationGroup group={value} agentId="home" />)

describe("delegated work presentation", () => {
  it("keeps idle asynchronous children steerable and stoppable", () => {
    const html = render({
      ...group,
      detached: true,
      children: [
        {
          ...group.children[0]!,
          status: "completed",
          answer: "Initial findings",
        },
      ],
    })
    expect(html).toContain("Idle · available for messages")
    expect(html).toContain("Steer Research")
    expect(html).toContain("Stop task")
    expect(html).not.toContain("Parent is waiting for results")
  })
  it("offers steering and stopping only while the parent and branch are active", () => {
    const live = render(group)
    expect(live).toContain("Steer Research")
    expect(live).toContain("Stop task")
    expect(live).toContain('data-status="running"')
    const cancelled = render({ ...group, status: "cancelled" })
    expect(cancelled).toContain("Stopped with parent")
    expect(cancelled).not.toContain('data-status="running"')
    expect(cancelled).not.toContain("Steer Research")
    expect(cancelled).not.toContain("Stop task")
  })

  it("shows unfinished branches as interrupted after a parent settles", () => {
    const html = render({ ...group, status: "completed" })
    expect(html).toContain("Interrupted")
    expect(html).not.toContain('data-status="running"')
    expect(html).not.toContain("Stop task")
  })

  it("keeps completed results and steering history available inside a closed branch", () => {
    const html = render({
      ...group,
      status: "completed",
      children: [
        {
          ...group.children[0]!,
          status: "completed",
          answer: "Use `pnpm`.\n\n```bash\npnpm build\n```",
          steering: ["Keep it concise"],
        },
      ],
    })
    expect(html).toContain("Copy code")
    expect(html).toContain("pnpm build")
    expect(html).toContain("Steering history")
    expect(html).toContain("Keep it concise")
  })
})
