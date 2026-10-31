import { Schema } from "effect"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { expect, it, vi } from "vitest"

import {
  AgentList,
  AgentProfileResponse,
  homeAgentId,
  type AgentProfile,
} from "../src/agents/contracts"
import { SidebarProvider } from "../src/components/ui/sidebar"
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
  slug: "research",
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
    <SidebarProvider>
      <AgentCollection
        agents={[
          {
            ...agent,
            id: homeAgentId,
            slug: "personal-assistant",
            name: "Home",
          },
          { ...agent, status: archived ? "archived" : "active" },
        ]}
        archived={archived}
        query=""
        onQuery={() => {}}
        onCreate={() => {}}
        onArchive={() => {}}
      />
    </SidebarProvider>
  )
}
it("lists archived agents with Restore and no link into their workspace", () => {
  const html = render(true)
  expect(html).toContain('aria-label="Restore Research"')
  expect(html).not.toContain(`/agents/${agent.id}`)
  expect(html).toContain('href="/agents"')
  expect(html).not.toContain('href="/agents/personal-assistant"')
})
it("offers Archive beside active agents and protects Home from archiving", () => {
  const html = render(false)
  expect(html).toContain('aria-label="Archive Research"')
  expect(html).not.toContain('aria-label="Archive Home"')
  expect(html).toContain(`href="/agents/${agent.slug}"`)
})

it("keeps ID links usable when a rolling-deploy catalog predates slugs", () => {
  const { slug: _slug, ...legacy } = agent
  const decoded = Schema.decodeUnknownSync(AgentList)({ agents: [legacy] })
  expect(decoded.agents[0]!.slug).toBe(agent.id)
  expect(Schema.decodeUnknownSync(AgentProfileResponse)(legacy)).toEqual(
    decoded.agents[0]
  )
  const html = renderToStaticMarkup(
    <SidebarProvider>
      <AgentCollection
        agents={[...decoded.agents]}
        archived={false}
        query=""
        onQuery={() => {}}
        onCreate={() => {}}
        onArchive={() => {}}
      />
    </SidebarProvider>
  )
  expect(html).toContain(`href="/agents/${agent.id}"`)
})

it("retains canonical catalog slugs and rejects malformed supplied slugs", () => {
  expect(
    Schema.decodeUnknownSync(AgentList)({ agents: [agent] }).agents[0]!.slug
  ).toBe("research")
  for (const slug of [null, "../other-agent", "Uppercase", ""]) {
    expect(() =>
      Schema.decodeUnknownSync(AgentList)({ agents: [{ ...agent, slug }] })
    ).toThrow()
  }
  const { slug: _slug, ...legacy } = agent
  expect(() =>
    Schema.decodeUnknownSync(AgentList)({
      agents: [{ ...legacy, id: "../other-agent" }],
    })
  ).toThrow()
})
