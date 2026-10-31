import type * as Router from "@tanstack/react-router"
import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { homeAgentId, type AgentProfile } from "../src/agents/contracts"
import { ChatApp } from "../src/app/workspace"
import { parseAgentId } from "../src/navigation/workspace"

const harness = vi.hoisted(() => ({
  pathname: "/agents",
  pendingPathname: undefined as string | undefined,
  navigate: vi.fn(),
  select: vi.fn(),
  choose: undefined as ((id: AgentProfile["id"]) => void) | undefined,
  act: undefined as ((action: "settings" | "security") => void) | undefined,
}))
const selectedAgent: AgentProfile = {
  slug: "research",
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
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) =>
    select([
      {
        pathname: harness.pathname,
        params: harness.pathname.startsWith("/agents/home")
          ? { agentId: "home", panel: "files" }
          : {},
        search: {},
      },
    ]),
  useLocation: ({ select }: { select: (location: unknown) => unknown }) =>
    select({
      pathname: harness.pendingPathname ?? harness.pathname,
      href: harness.pendingPathname ?? harness.pathname,
    }),
  useNavigate: () => harness.navigate,
  useRouter: () => ({ history: { back: vi.fn() } }),
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
  WorkspaceNavigation: (props: {
    onSelect: typeof harness.choose
    onAction: typeof harness.act
  }) => {
    harness.choose = props.onSelect
    harness.act = props.onAction
    return <nav aria-label="Workspace commands" />
  },
}))

beforeEach(() => {
  vi.clearAllMocks()
  harness.pathname = "/agents"
  harness.pendingPathname = undefined
  harness.choose = undefined
  harness.act = undefined
})

describe.each(["/agents", "/agents/archived"])(
  "%s keeps management inside the single workspace shell",
  (pathname) => {
    it("renders one navigation and no conversation workbench", () => {
      harness.pathname = pathname
      const html = renderToStaticMarkup(<ChatApp />)
      expect(html.match(/aria-label="Workspace commands"/g)).toHaveLength(1)
      expect(html).not.toContain('aria-label="Agents and workspace"')
      expect(html).not.toContain('aria-label="Workbench tool"')
      expect(harness.choose).toBeTypeOf("function")
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

it.each([
  ["settings", "/settings"],
  ["security", "/settings/security"],
] as const)(
  "opens account-owned %s from the committed workbench without adopting a pending location",
  (action, to) => {
    harness.pathname = "/agents/home/files"
    harness.pendingPathname = "/agents/research"
    renderToStaticMarkup(<ChatApp />)
    harness.act!(action)
    expect(harness.navigate).toHaveBeenCalledWith(
      expect.objectContaining({
        to,
        params: {},
        search: expect.objectContaining({ returnTo: "/agents/home/files" }),
      })
    )
  }
)
