import { describe, expect, it } from "vitest"
import {
  defaultStringifySearch,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from "@tanstack/react-router"
import {
  parseAgentId,
  parsePanel,
  parseResourceId,
  parseSection,
  validateWorkspaceSearch,
  workspaceView,
  workspaceDestination,
  workspaceReturnPath,
  workspaceReturnLink,
  validateAuthSearch,
  editorDestination,
} from "../src/navigation/workspace"

const id = parseAgentId("home")
describe("canonical workspace locations", () => {
  it.each([
    "browser",
    "code",
    "apps",
    "terminal",
    "routines",
    "objects",
    "activity",
    "files",
    "memory",
  ])("uses a page path for %s", (panel) => {
    const value = parsePanel(panel)
    const destination = workspaceDestination(id, { panel: value })
    expect(destination.to).toBe("/agents/$agentId/$panel")
    expect(destination.params).toEqual({ agentId: id, panel })
    expect(destination.search).toEqual({})
    expect(workspaceReturnPath(`/agents/home/${panel}`)).toBe(
      `/agents/home/${panel}`
    )
  })
  it.each([
    "general",
    "models",
    "access",
    "skills",
    "memory",
    "connections",
    "security",
  ])("uses a page path for Settings %s", (section) => {
    expect(workspaceReturnPath(`/agents/home/settings/${section}`)).toBe(
      `/agents/home/settings/${section}`
    )
  })
  it("keeps resource identity in the path and selected views in query parameters", () => {
    const path = "/agents/home/files/file_1?tab=trash"
    expect(workspaceReturnPath(path)).toBe(path)
    expect(
      workspaceReturnPath(path + "&approve=true&prompt=act&token=private")
    ).toBe(path)
    expect(
      workspaceDestination(id, { panel: "files", item: "file_1", tab: "trash" })
    ).toEqual({
      to: "/agents/$agentId/$panel/$itemId",
      params: { agentId: id, panel: "files", itemId: "file_1" },
      search: { tab: "trash" },
    })
  })
  it("retains an underlying resource when nested Settings opens, and restores it on close", () => {
    const view = workspaceView(
      { agentId: id, section: "security" },
      { panel: "files", item: "file_1", tab: "trash" }
    )
    expect(view).toMatchObject({
      settings: "general",
      security: true,
      panel: "files",
      item: "file_1",
    })
    expect(workspaceDestination(id, view).params).toMatchObject({
      section: "security",
    })
    expect(
      workspaceDestination(id, {
        ...view,
        settings: undefined,
        security: undefined,
      }).to
    ).toBe("/agents/$agentId/$panel/$itemId")
  })
  it("normalizes a Settings index return to its canonical General page", () => {
    expect(
      workspaceReturnPath("/agents/home/settings?panel=files&item=file_1")
    ).toBe("/agents/home/settings/general?panel=files&item=file_1")
    expect(workspaceReturnLink("/agents/home/settings")).toMatchObject({
      params: { section: "general" },
    })
  })
  it("provides a distinct archive collection with bookmarkable filtering", () => {
    expect(
      workspaceReturnPath("/agents/archived?q=Research&restore=true")
    ).toBe("/agents/archived?q=Research")
    expect(workspaceReturnPath("/agents?q=Studio")).toBe("/agents?q=Studio")
  })
  it.each([
    "https://evil.example/agents/home",
    "//evil.example/agents/home",
    "/\\evil.example/agents/home",
    "javascript:alert(1)",
    "/api/agent/send",
    "/agents/home/../../api/agent/send",
    "/agents/not-a-bot",
    "/agents/home/files/../secret",
    "/agents/home/files?tab=webhook",
    "/agents/home?item=orphan",
    "/agents/home/files/file_1?item=other",
    "/agents/home/terminal?activityAgent=home",
    "/agents/home/browser/resource",
    "/agents/home/settings/nope",
    "/agents/home#unvalidated",
  ])("rejects unsafe or inconsistent destinations: %s", (path) => {
    expect(workspaceReturnPath(path)).toBe("/")
  })
  it("validates identifiers and query types using Effect Schema", () => {
    expect(() =>
      validateWorkspaceSearch({ tab: ["tasks", "timeline"] })
    ).toThrow()
    expect(() => validateWorkspaceSearch({ q: "x".repeat(201) })).toThrow()
    expect(() => parseAgentId("other-owner/home")).toThrow()
    expect(() => parseResourceId("../secret")).toThrow()
    expect(() => workspaceView({ panel: "files" }, { panel: "apps" })).toThrow()
  })
  it("accepts a valid unknown bot without substituting home; catalog and server own authorization", () => {
    const bot = "11111111-1111-4111-8111-111111111111"
    expect(
      workspaceReturnPath(`/agents/${bot}/activity/plan_1?tab=tasks`)
    ).toBe(`/agents/${bot}/activity/plan_1?tab=tasks`)
  })
})

describe("validated view state and auth return", () => {
  it("round-trips native JSON search encoding, including cursor objects and numeric-looking filter text", () => {
    const cursor = { at: "2026-10-12T12:00:00.000Z", key: "synthetic-record" }
    const search = {
      tab: "timeline" as const,
      scope: "all" as const,
      filter: "attention" as const,
      cursor,
      q: "123",
    }
    const path = `/agents/home/activity${defaultStringifySearch(search)}`
    expect(workspaceReturnPath(path)).toBe(path)
    expect(workspaceReturnLink(path).search).toEqual(search)
    expect(
      workspaceReturnPath("/agents/home/files/file_1?preview=source")
    ).toBe("/agents/home/files/file_1?preview=source")
    expect(
      workspaceReturnPath("/agents/home/memory?tab=history&query=coffee")
    ).toBe("/agents/home/memory?tab=history&query=coffee")
  })
  it.each([
    "/agents/home/files?preview=source",
    "/agents/home/files?filter=running",
    "/agents/home/activity?filter=invalid",
    "/agents/home/activity?offset=-1",
    "/agents/home/activity?offset=0.5",
    "/agents/home/activity?offset=100001",
    "/agents/home/files?query=private",
    "/agents/home/activity?cursor=%7B%22at%22%3A%22bad%22%7D",
  ])("rejects out-of-scope or malformed view state: %s", (path) => {
    expect(workspaceReturnPath(path)).toBe("/")
  })
  it("addresses editor screens and validates their return location", () => {
    const to = "/agents/home/files/file_1?preview=source"
    const path = `/agents/new${defaultStringifySearch({ returnTo: to })}`
    expect(workspaceReturnPath(path)).toBe(path)
    expect(workspaceReturnLink(path)).toEqual(editorDestination(undefined, to))
    expect(
      workspaceReturnLink(
        "/agents/home/edit?returnTo=https%3A%2F%2Fevil.example"
      )
    ).toEqual(editorDestination(id, "/"))
    expect(
      workspaceReturnPath("/agents/home/settings/general?settingsView=sections")
    ).toBe("/agents/home/settings/general?settingsView=sections")
    expect(
      workspaceReturnPath("/agents/home/files?settingsView=sections")
    ).toBe("/")
  })
  it("sanitizes auth destinations without storing or forwarding bearer/action parameters", () => {
    expect(
      validateAuthSearch({
        returnTo: "/agents/archived?q=Research&restore=true",
        token: "private",
      })
    ).toEqual({ returnTo: "/agents/archived?q=Research" })
    expect(validateAuthSearch({ returnTo: "https://evil.example" })).toEqual({
      returnTo: "/",
    })
    expect(workspaceReturnLink("/agents/home/settings/security")).toMatchObject(
      { params: { agentId: "home", section: "security" } }
    )
  })
})

// Use native route matching/history, rather than proving only the destination builder.
function routerAt(initialPath: string) {
  const root = createRootRoute()
  const route = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch: validateWorkspaceSearch,
      params: {
        parse: (params: Record<string, string>) => ({
          ...params,
          ...(params.agentId ? { agentId: parseAgentId(params.agentId) } : {}),
          ...(params.panel ? { panel: parsePanel(params.panel) } : {}),
          ...(params.itemId ? { itemId: parseResourceId(params.itemId) } : {}),
          ...(params.section ? { section: parseSection(params.section) } : {}),
        }),
      },
      beforeLoad: ({ params, search }) => {
        workspaceView(params, search)
      },
    })
  return createRouter({
    routeTree: root.addChildren([
      route("/agents"),
      route("/agents/archived"),
      route("/agents/$agentId"),
      route("/agents/$agentId/$panel"),
      route("/agents/$agentId/$panel/$itemId"),
      route("/agents/$agentId/settings/$section"),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    isServer: true,
  })
}
describe("native TanStack routing", () => {
  it("matches a direct resource link, then preserves state through Settings, Back and Forward", async () => {
    const router = routerAt("/agents/home/files/file_1?tab=trash")
    await router.load()
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      agentId: "home",
      panel: "files",
      itemId: "file_1",
    })
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: "trash" })
    router.history.push(
      "/agents/home/settings/security?panel=files&item=file_1&tab=trash"
    )
    await router.load()
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      section: "security",
    })
    router.history.back()
    await router.load()
    expect(router.state.location.pathname).toBe("/agents/home/files/file_1")
    router.history.forward()
    await router.load()
    expect(router.state.matches.at(-1)?.search).toMatchObject({
      panel: "files",
      item: "file_1",
      tab: "trash",
    })
  })
  it("matches the archive collection before the dynamic agent path", async () => {
    const router = routerAt("/agents/archived?q=Studio")
    await router.load()
    expect(router.state.matches.at(-1)?.routeId).toBe("/agents/archived")
    expect(router.state.matches.at(-1)?.params).toEqual({})
  })
  it("puts mismatched search state into the route error boundary", async () => {
    const router = routerAt("/agents/home/files?tab=webhook")
    await router.load()
    expect(router.state.matches.at(-1)?.status).toBe("error")
  })
})
