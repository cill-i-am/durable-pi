import type * as Router from "@tanstack/react-router"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { ChatApp } from "../src/app/workspace"
import { parseAgentId } from "../src/navigation/workspace"

const harness = vi.hoisted(() => ({
  pathname: "/agents",
  navigate: vi.fn(),
  select: vi.fn(),
  choose: undefined as ((id: AgentProfile["id"]) => void) | undefined,
}))
const selectedAgent: AgentProfile = {
  id: parseAgentId("11111111-1111-4111-8111-111111111111"),
  name: "Research",
  instructions: "",
  status: "active",
  revision: 1,
  createdAt: "2026-10-18",
  updatedAt: "2026-10-18",
}
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof Router>()),
  useParams: () =>
    harness.pathname.startsWith("/agents/home")
      ? { agentId: "home", panel: "files" }
      : {},
  useSearch: () => ({}),
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({ pathname: harness.pathname, href: harness.pathname }),
  useNavigate: () => harness.navigate,
  useBlocker: () => ({}),
}))
vi.mock("../src/auth/client", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "navigation-test", name: "Tester" } },
      isPending: false,
    }),
  },
}))
vi.mock("../src/features/family/context", () => ({
  FamilyWorkspace: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("../src/features/conversation", () => ({
  useConversation: () => ({}),
}))
vi.mock("../src/features/agents", () => ({
  useAgentCatalog: () => ({
    agents: [selectedAgent],
    selected: harness.pathname.startsWith("/agents/home")
      ? undefined
      : selectedAgent,
    select: harness.select,
    loading: false,
  }),
  AgentSidebar: () => <nav aria-label="Agents and workspace" />,
  AgentEditor: () => null,
  ArchiveAgentDialog: () => null,
}))
vi.mock("../src/features/agents/agent-collection", () => ({
  AgentCollection: () => null,
}))
vi.mock("../src/features/agents/use-agent-statuses", () => ({
  useAgentStatuses: () => ({ statuses: {} }),
}))
vi.mock("../src/app/workspace-navigation", () => ({
  WorkspaceNavigation: (props: { onSelect: typeof harness.choose }) => {
    harness.choose = props.onSelect
    return <nav aria-label="Workspace commands" />
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  harness.pathname = "/agents"
  harness.choose = undefined
})

describe.each(["/agents", "/agents/archived"])(
  "%s is a standalone management list",
  (pathname) => {
    it("does not render workspace commands, an agent sidebar, or a workbench", () => {
      harness.pathname = pathname
      const html = renderToStaticMarkup(<ChatApp />)
      expect(html).not.toContain('aria-label="Workspace commands"')
      expect(html).not.toContain('aria-label="Agents and workspace"')
      expect(html).not.toContain('aria-label="Workbench tool"')
      expect(harness.choose).toBeUndefined()
    })
  }
)
it("choosing the current agent returns from its workbench to its conversation", () => {
  harness.pathname = "/agents/home/files"
  renderToStaticMarkup(<ChatApp />)
  harness.choose!(homeAgentId)
  expect(harness.navigate).toHaveBeenCalledWith(
    expect.objectContaining({
      to: "/agents/$agentId",
      params: { agentId: homeAgentId },
      search: {},
    })
  )
})
