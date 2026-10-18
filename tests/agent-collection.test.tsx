import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { AgentCollection } from "../src/features/agents/agent-collection"
import { parseAgentId } from "../src/navigation/workspace"

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  Link: ({
    to,
    params,
    children,
  }: {
    to: string
    params?: { agentId: string }
    children: ReactNode
  }) => <a href={to.replace("$agentId", params?.agentId ?? "")}>{children}</a>,
}))
const agent: AgentProfile = {
  id: parseAgentId("11111111-1111-4111-8111-111111111111"),
  name: "Research",
  instructions: "Review sources",
  status: "active",
  revision: 1,
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18",
}
function render(archived: boolean) {
  return renderToStaticMarkup(
    <AgentCollection
      agents={[
        { ...agent, id: homeAgentId, name: "Home" },
        { ...agent, status: archived ? "archived" : "active" },
      ]}
      archived={archived}
      query=""
      onQuery={() => {}}
      onCreate={() => {}}
      onArchive={() => {}}
    />
  )
}
it("lists archived agents with Restore and no link into their workspace", () => {
  const html = render(true)
  expect(html).toContain('aria-label="Restore Research"')
  expect(html).not.toContain(`/agents/${agent.id}`)
  expect(html).toContain('href="/agents/home"')
})
it("offers Archive beside active agents and protects Home from archiving", () => {
  const html = render(false)
  expect(html).toContain('aria-label="Archive Research"')
  expect(html).not.toContain('aria-label="Archive Home"')
  expect(html).toContain(`href="/agents/${agent.id}"`)
})
