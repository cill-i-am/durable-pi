import {
  defaultStringifySearch,
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
} from "@tanstack/react-router"
import { describe, expect, it } from "vitest"

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
  workspaceRouteSearch,
  workspaceContext,
  parseWorkspaceParams,
  parseAgentReference,
  validateGlobalSettingsSearch,
  validateConnectionSettingsSearch,
  workspaceBackdrop,
  globalSettingsView,
  globalSettingsSection,
} from "../src/navigation/workspace"

const id = parseAgentId("home")
const globalRoutes = [
  ["/settings", "settings"],
  ["/settings/account", "account"],
  ["/settings/preferences", "preferences"],
  ["/settings/security", "security"],
  ["/settings/connections", "connection-library"],
  ["/settings/skills", "skill-library"],
  ["/settings/channels", "channels"],
  ["/family", "family"],
  ["/family/model-access", "model-access"],
] as const
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
  it.each(["general", "models", "access", "skills", "connections"])(
    "uses a page path for Settings %s",
    (section) => {
      expect(workspaceReturnPath(`/agents/home/settings/${section}`)).toBe(
        `/agents/home/settings/${section}`
      )
    }
  )
  it.each([
    "family",
    "model-access",
    "security",
    "account",
    "preferences",
    "connection-library",
    "skill-library",
    "channels",
    "memory",
  ])(
    "rejects removed assistant-scoped %s settings instead of redirecting",
    (section) => {
      const path = `/agents/home/settings/${section}`
      expect(() => parseSection(section)).toThrow()
      expect(workspaceReturnPath(path)).toBe("/")
      expect(
        workspaceReturnPath(`${path}?panel=files&item=file_1&tab=trash`)
      ).toBe("/")
      expect(workspaceReturnLink(path)).toEqual({ to: "/", search: {} })
      expect(validateAuthSearch({ returnTo: path })).toEqual({ returnTo: "/" })
    }
  )
  it.each(globalRoutes)(
    "addresses global %s settings directly without an assistant",
    (path) => {
      expect(workspaceReturnPath(path)).toBe(path)
      expect(workspaceReturnLink(path)).toEqual({
        to: path,
        search: { returnTo: undefined },
      })
      expect(validateAuthSearch({ returnTo: path })).toEqual({ returnTo: path })
    }
  )
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
    const view = globalSettingsView("security", {
      returnTo: "/agents/home/files/file_1?tab=trash",
    })
    expect(view).toMatchObject({
      settings: "security",
      security: true,
      panel: "files",
      item: "file_1",
    })
    expect(workspaceDestination(id, view)).toEqual({
      to: "/settings/security",
      params: {},
      search: {
        returnTo: "/agents/home/files/file_1?tab=trash",
      },
    })
    expect(
      workspaceDestination(id, {
        ...view,
        settings: undefined,
        security: undefined,
      }).to
    ).toBe("/agents/$agentId/$panel/$itemId")
  })
  it("addresses the agent settings list without redirecting to General", () => {
    expect(
      workspaceReturnPath("/agents/home/settings?panel=files&item=file_1")
    ).toBe("/agents/home/settings?panel=files&item=file_1")
    expect(workspaceReturnPath("/agents/home/settings")).toBe(
      "/agents/home/settings"
    )
    expect(workspaceReturnLink("/agents/home/settings")).toEqual({
      to: "/agents/$agentId/settings",
      params: { agentId: "home" },
      search: { panel: undefined, item: undefined },
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
    "/agents/invalid.slug",
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
  it.each(["terminal", "code"] as const)(
    "keeps the native %s execution identity in saved-run links",
    (panel) => {
      const item = `${panel === "terminal" ? "command" : "code"}:task_123`
      expect(workspaceDestination(id, { panel, item }).params).toEqual({
        agentId: id,
        panel,
        itemId: item,
      })
      expect(
        workspaceReturnLink(`/agents/home/${panel}/${encodeURIComponent(item)}`)
      ).toMatchObject({ params: { agentId: id, panel, itemId: item } })
      expect(
        workspaceReturnPath(
          `/agents/home/settings/general?panel=${panel}&item=${encodeURIComponent(item)}`
        )
      ).not.toBe("/")
    }
  )
  it.each([
    "",
    "../secret",
    "a/b",
    "a\\b",
    "a?b",
    "a#b",
    "a%b",
    "a b",
    "x".repeat(201),
  ])("rejects unsafe or oversized resource identity %s", (item) =>
    expect(() => parseResourceId(item)).toThrow()
  )
  it.each([
    "a%2Fb",
    "a%5Cb",
    "a%252Fb",
    "a%00b",
    "a%3Fb",
    "a%23b",
    "a%20b",
    "a%ZZb",
  ])(
    "rejects encoded path separators and malformed resource identity %s",
    (item) => {
      const path = `/agents/home/terminal/${item}`
      expect(workspaceReturnPath(path)).toBe("/")
      expect(workspaceReturnLink(path)).toEqual({ to: "/", search: {} })
    }
  )
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
    ).toBe("/agents/home/settings/general")
    expect(
      workspaceReturnPath("/agents/home/files?settingsView=sections")
    ).toBe("/agents/home/files")
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
    expect(
      workspaceReturnLink("/settings/security?returnTo=%2Fagents%2Fhome")
    ).toEqual({
      to: "/settings/security",
      search: { returnTo: "/agents/home" },
    })
  })
})

describe("global settings and retained assistant backdrops", () => {
  it("strips raw query keys before they can override a global backdrop", () => {
    const query = {
      returnTo: "/agents/research/terminal",
      panel: "files",
      item: "file_1",
      approve: true,
    }
    expect(globalSettingsView("family", query)).toMatchObject({
      panel: "terminal",
      settings: "family",
    })
    expect(globalSettingsView("family", query).item).toBeUndefined()
    expect(globalSettingsView("family", query)).not.toHaveProperty("approve")
  })
  it.each(globalRoutes)(
    "recognizes the canonical %s route and preserves an auth return",
    (path, section) => {
      const returnTo =
        "/agents/meal-planning/terminal/command%3Atask_123?tab=interactive"
      const query = { returnTo }
      const destination = `${path}${defaultStringifySearch(query)}`
      expect(globalSettingsSection(path)).toBe(section)
      expect(workspaceReturnPath(destination)).toBe(destination)
      expect(workspaceReturnLink(destination)).toEqual({
        to: path,
        search: query,
      })
      expect(validateAuthSearch({ returnTo: destination })).toEqual({
        returnTo: destination,
      })
    }
  )

  it.each([
    "/family/nope",
    "/family/model-access/extra",
    "/settings/general",
    "/settings/security/extra",
  ])("does not treat unsupported global path %s as settings", (path) => {
    expect(globalSettingsSection(path)).toBeUndefined()
    expect(workspaceReturnPath(path)).toBe("/")
  })

  it("restores the full resource view while keeping global selection separate", () => {
    const returnTo =
      "/agents/meal-planning/files/file_1?tab=trash&preview=source"
    expect(workspaceBackdrop(returnTo)).toMatchObject({
      params: { agentId: "meal-planning", panel: "files", itemId: "file_1" },
      view: { panel: "files", item: "file_1", tab: "trash", preview: "source" },
      path: returnTo,
    })
    expect(globalSettingsView("security", { returnTo })).toMatchObject({
      returnTo,
      settings: "security",
      security: true,
      panel: "files",
      item: "file_1",
      tab: "trash",
      preview: "source",
    })
    for (const [, section] of globalRoutes.filter(
      ([, value]) => value !== "security"
    )) {
      expect(globalSettingsView(section, { returnTo })).toMatchObject({
        settings: section,
        security: undefined,
        panel: "files",
        item: "file_1",
      })
    }
  })

  it("retains native activity filters and removes action parameters from both query levels", () => {
    const cursor = { at: "2026-10-12T12:00:00.000Z", key: "synthetic-record" }
    const view = {
      tab: "timeline",
      scope: "all",
      filter: "attention",
      cursor,
      offset: 2,
    }
    const safe = `/agents/home/activity${defaultStringifySearch(view)}`
    const query = validateGlobalSettingsSearch({
      returnTo: `${safe}&approve=true&token=private`,
      settingsView: "sections",
      panel: "terminal",
      token: "private",
    })
    expect(query).toEqual({ returnTo: safe })
    expect(globalSettingsView("family", query)).toMatchObject({
      ...view,
      panel: "activity",
      settings: "family",
    })
  })

  it("retains OAuth callback status only in the global connection library", () => {
    const returnTo = "/agents/research/terminal"
    for (const connections of ["connected", "failed"] as const) {
      const query = { returnTo, connections, approve: true, token: "private" }
      expect(validateConnectionSettingsSearch(query)).toEqual({
        returnTo,
        connections,
      })
      for (const [path, section] of globalRoutes) {
        const safe = workspaceRouteSearch(path, query)
        const expected =
          section === "connection-library"
            ? { returnTo, connections }
            : { returnTo }
        expect(safe).toEqual(expected)
        const incoming = path + defaultStringifySearch(query)
        const canonical = path + defaultStringifySearch(expected)
        expect(workspaceReturnPath(incoming)).toBe(canonical)
        expect(workspaceReturnLink(incoming)).toEqual({
          to: path,
          search: expected,
        })
        expect(validateAuthSearch({ returnTo: incoming })).toEqual({
          returnTo: canonical,
        })
        expect(globalSettingsView(section, safe).connections).toBe(
          section === "connection-library" ? connections : undefined
        )
        expect(globalSettingsView(section, safe)).not.toHaveProperty("approve")
      }
    }
    expect(() =>
      validateConnectionSettingsSearch({ connections: "approved" })
    ).toThrow()
  })

  it("retains an explicit unknown assistant instead of substituting home", () => {
    const reference = "11111111-1111-4111-8111-111111111111"
    const returnTo = `/agents/${reference}/files/file_1`
    expect(validateGlobalSettingsSearch({ returnTo })).toEqual({ returnTo })
    expect(workspaceBackdrop(returnTo)?.params.agentId).toBe(reference)
    const destination = `/family${defaultStringifySearch({ returnTo })}`
    expect(workspaceReturnPath(destination)).toBe(destination)
  })

  it.each([
    "https://evil.example/agents/home",
    "//evil.example/agents/home",
    "/\\evil.example/agents/home",
    "javascript:alert(1)",
    "/api/agent/send",
    "/agents",
    "/agents/new",
    "/agents/archived",
    "/agents/home/edit",
    "/agents/home/settings/general",
    "/agents/home#private-reset",
    "/agents/home/files?tab=webhook",
    "/agents/home/browser/file_1",
    "/agents/home/terminal/a%2Fb",
    "/family?returnTo=%2Fagents%2Fhome",
    "/settings/security?returnTo=%2Ffamily",
  ])("rejects unsafe, inconsistent or recursive backdrop %s", (returnTo) => {
    expect(workspaceBackdrop(returnTo)).toBeUndefined()
    expect(validateGlobalSettingsSearch({ returnTo })).toEqual({
      returnTo: undefined,
    })
  })

  it("validates global query types and leaves direct global routes without invented context", () => {
    expect(validateGlobalSettingsSearch({})).toEqual({ returnTo: undefined })
    expect(globalSettingsView("family", {})).toEqual({
      settings: "family",
      security: undefined,
    })
    expect(() =>
      validateGlobalSettingsSearch({ returnTo: ["/agents/home"] })
    ).toThrow()
    expect(() =>
      validateGlobalSettingsSearch({ returnTo: "x".repeat(2001) })
    ).toThrow()
    expect(validateGlobalSettingsSearch({ settingsView: "unknown" })).toEqual({
      returnTo: undefined,
    })
  })
})

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
          ...(params.agentId
            ? { agentId: parseAgentReference(params.agentId) }
            : {}),
          ...(params.panel ? { panel: parsePanel(params.panel) } : {}),
          ...(params.itemId ? { itemId: parseResourceId(params.itemId) } : {}),
          ...(params.section ? { section: parseSection(params.section) } : {}),
        }),
      },
      beforeLoad: ({ params, search }) => {
        workspaceView(
          path === "/agents/$agentId/settings"
            ? { ...params, section: "agent-settings" }
            : params,
          search
        )
      },
    })
  const global = (path: string) =>
    createRoute({
      getParentRoute: () => root,
      path,
      validateSearch:
        path === "/settings/connections"
          ? validateConnectionSettingsSearch
          : validateGlobalSettingsSearch,
    })
  return createRouter({
    routeTree: root.addChildren([
      route("/agents"),
      route("/agents/archived"),
      route("/agents/$agentId"),
      route("/agents/$agentId/$panel"),
      route("/agents/$agentId/$panel/$itemId"),
      route("/agents/$agentId/settings/$section"),
      route("/agents/$agentId/settings"),
      ...globalRoutes.map(([path]) => global(path)),
    ]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
    isServer: true,
  })
}
describe("native TanStack routing", () => {
  it.each([
    "/agents/home/settings/family",
    "/agents/home/settings/model-access",
    "/agents/home/settings/security",
    "/agents/home/settings/memory",
    "/agents/home/settings/account",
    "/agents/home/settings/preferences",
  ])(
    "rejects removed settings route %s without navigating to a replacement",
    async (path) => {
      const router = routerAt(path)
      await router.load()
      expect(router.state.matches.at(-1)?.status).toBe("notFound")
      expect(router.state.location.pathname).toBe(path)
    }
  )
  it("revalidates merged router search before choosing a global overlay's backdrop", async () => {
    const router = routerAt(
      `/family${defaultStringifySearch({ returnTo: "/agents/home/terminal", panel: "files", item: "file_1", approve: true })}`
    )
    await router.load()
    const match = router.state.matches.at(-1)!
    const query = workspaceRouteSearch(match.pathname, match.search)
    const context = workspaceContext(
      match.pathname,
      parseWorkspaceParams(match.params),
      query
    )
    expect(context.params).toMatchObject({ agentId: "home", panel: "terminal" })
    expect(context.view).toMatchObject({
      panel: "terminal",
      settings: "family",
    })
    expect(context.view.item).toBeUndefined()
    expect(context.view).not.toHaveProperty("approve")
  })
  it.each(["terminal", "code"] as const)(
    "round-trips a Pi %s receipt through resource, Settings and history navigation",
    async (panel) => {
      const item = `${panel === "terminal" ? "command" : "code"}:task_123`
      const router = routerAt(`/agents/home/${panel}`)
      await router.load()
      router.history.push(
        router.buildLocation(workspaceDestination(id, { panel, item })).href
      )
      await router.load()
      expect(router.state.matches.at(-1)?.status).toBe("success")
      expect(router.state.matches.at(-1)?.params).toMatchObject({
        itemId: item,
      })
      const resourceUrl = router.state.location.href
      expect(workspaceReturnPath(resourceUrl)).toBe(resourceUrl)
      router.history.push(
        router.buildLocation(
          workspaceDestination(id, { panel, item, settings: "general" })
        ).href
      )
      await router.load()
      expect(router.state.matches.at(-1)?.search).toMatchObject({ item })
      router.history.back()
      await router.load()
      expect(router.state.matches.at(-1)?.params).toMatchObject({
        itemId: item,
      })
      router.history.forward()
      await router.load()
      expect(router.state.matches.at(-1)?.search).toMatchObject({ item })
      router.history.push(
        router.buildLocation(workspaceDestination(id, { panel: "browser" }))
          .href
      )
      await router.load()
      expect(router.state.matches.at(-1)?.status).toBe("success")
      expect(router.state.matches.at(-1)?.params).not.toHaveProperty("itemId")
      expect(router.state.matches.at(-1)?.search).not.toHaveProperty("item")
    }
  )
  it("matches a direct resource link, then preserves state through Settings, Back and Forward", async () => {
    const router = routerAt("/agents/home/files/file_1?tab=trash")
    await router.load()
    expect(router.state.matches.at(-1)?.params).toMatchObject({
      agentId: "home",
      panel: "files",
      itemId: "file_1",
    })
    expect(router.state.matches.at(-1)?.search).toMatchObject({ tab: "trash" })
    const settingsUrl = router.buildLocation(
      workspaceDestination(id, {
        security: true,
        panel: "files",
        item: "file_1",
        tab: "trash",
      })
    ).href
    router.history.push(settingsUrl)
    await router.load()
    expect(router.state.location.pathname).toBe("/settings/security")
    expect(router.state.matches.at(-1)?.params).toEqual({})
    expect(router.state.matches.at(-1)?.search).toEqual({
      returnTo: "/agents/home/files/file_1?tab=trash",
    })
    router.history.back()
    await router.load()
    expect(router.state.location.pathname).toBe("/agents/home/files/file_1")
    router.history.forward()
    await router.load()
    expect(router.state.location.href).toBe(settingsUrl)
    const globalQuery = validateGlobalSettingsSearch(
      router.state.matches.at(-1)?.search
    )
    expect(workspaceBackdrop(globalQuery.returnTo ?? "")?.view).toMatchObject({
      panel: "files",
      item: "file_1",
      tab: "trash",
    })
  })
  it.each(globalRoutes)(
    "round-trips the same non-default terminal backdrop through global %s and native history",
    async (path, section) => {
      const reference = parseAgentReference("meal-planning")
      const backdrop =
        "/agents/meal-planning/terminal/command%3Atask_123?tab=interactive"
      const router = routerAt(backdrop)
      await router.load()
      const view = {
        panel: "terminal" as const,
        item: "command:task_123",
        tab: "interactive" as const,
      }
      const destination = workspaceDestination(reference, {
        ...view,
        ...(section === "security"
          ? { security: true }
          : { settings: section }),
      })
      router.history.push(router.buildLocation(destination).href)
      await router.load()
      expect(router.state.matches.at(-1)?.status).toBe("success")
      expect(router.state.location.pathname).toBe(path)
      expect(router.state.matches.at(-1)?.params).toEqual({})
      expect(router.state.matches.at(-1)?.search).toEqual({
        returnTo: backdrop,
      })
      expect(
        globalSettingsView(
          section,
          validateGlobalSettingsSearch(router.state.matches.at(-1)?.search)
        )
      ).toMatchObject(view)
      const overlayUrl = router.state.location.href
      router.history.back()
      await router.load()
      expect(router.state.location.href).toBe(backdrop)
      router.history.forward()
      await router.load()
      expect(router.state.location.href).toBe(overlayUrl)
      router.history.push(
        router.buildLocation(workspaceReturnLink(backdrop)).href
      )
      await router.load()
      expect(router.state.location.href).toBe(backdrop)
      expect(router.state.matches.at(-1)?.params).toMatchObject({
        agentId: "meal-planning",
        itemId: "command:task_123",
      })
    }
  )
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
