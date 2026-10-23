import { expect, test, type Page } from "@playwright/test"

const workbench = "/agents/navi/files?tab=trash"
const photo = {
  name: "route-draft.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64"
  ),
}
const destinations = [
  { path: "/settings/account", heading: "Account" },
  { path: "/settings/preferences", heading: "Preferences" },
  { path: "/settings/security", heading: "Account security" },
  { path: "/settings/connections", heading: "Connections" },
  { path: "/settings/skills", heading: "Skills" },
  { path: "/settings/channels", heading: "Channels" },
  { path: "/family", heading: "Family" },
  {
    path: "/family/model-access",
    heading: "Model access",
  },
] as const

test("merged raw query keys cannot replace a global setting's workbench backdrop", async ({
  page,
}) => {
  await signIn(page)
  await page.goto(
    `/family?${new URLSearchParams({ returnTo: workbench, panel: "browser", item: "file_1", approve: "true" })}`
  )
  await expect(
    page.getByRole("heading", { name: "Family", exact: true })
  ).toBeVisible()
  const picker = page.getByRole("combobox", {
    name: "Workbench tool",
    includeHidden: true,
  })
  await expect(picker).toContainText("Files")
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi\/files\?tab=trash$/)
  await expect(picker).toBeVisible()
  await expect(picker).toContainText("Files")
})
const research = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "research",
  name: "Research",
  instructions: "Synthetic non-default assistant",
  status: "active",
  revision: 1,
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
}

async function addResearch(page: Page, status = "active") {
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const data = await response.json()
    await route.fulfill({
      response,
      json: { ...data, agents: [...data.agents, { ...research, status }] },
    })
  })
}

async function mockLibraries(page: Page) {
  const tool = {
    name: "mcp_calendar_read",
    connectionId: `mcp-${"a".repeat(32)}`,
    connectionRevision: 0,
    connectionName: "Calendar service",
    remoteName: "Read calendar",
    description: "Read events from the connected calendar.",
    parameters: { type: "object", properties: {} },
  }
  const connection = {
    id: tool.connectionId,
    name: tool.connectionName,
    url: "https://calendar.household.dev/mcp",
    revision: 0,
    active: true,
    status: "ready",
    authorizeUrl: null,
    tools: [tool],
  }
  const skill = {
    id: "22222222-2222-4222-8222-222222222222",
    name: "Family planning",
    body: "Keep family plans practical and easy to scan.",
    revision: 2,
    stateRevision: 1,
    createdAt: "2026-10-23T00:00:00.000Z",
    archived: false,
  }
  let tools = { revision: 0, tools: [] as (typeof tool)[] }
  let skills = { revision: 0, skills: [] as (typeof skill)[] }
  const writes: { kind: string; agent: string | null; input: unknown }[] = []
  await page.route(
    (url) =>
      url.pathname.startsWith("/api/agent/connections") ||
      url.pathname.startsWith("/api/agent/skills") ||
      [
        "/api/agent/remote-tools",
        "/api/agent/skill-selection",
        "/api/agent/access",
      ].includes(url.pathname),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const input =
        request.method() === "POST" ? request.postDataJSON() : undefined
      if (url.pathname === "/api/agent/remote-tools") {
        if (input) {
          writes.push({
            kind: "tools",
            agent: url.searchParams.get("agent"),
            input,
          })
          tools = {
            revision: tools.revision + 1,
            tools: input.names.includes(tool.name) ? [tool] : [],
          }
        }
        await route.fulfill({ json: tools })
      } else if (url.pathname === "/api/agent/skill-selection") {
        if (input) {
          writes.push({
            kind: "skills",
            agent: url.searchParams.get("agent"),
            input,
          })
          skills = {
            revision: skills.revision + 1,
            skills: input.skills.some(
              (value: { id: string }) => value.id === skill.id
            )
              ? [skill]
              : [],
          }
        }
        await route.fulfill({ json: skills })
      } else if (url.pathname === "/api/agent/access") {
        await route.fulfill({
          json: {
            tools: [
              {
                name: "read_browser",
                title: "Read browser page",
                description: "Read this assistant's browser page.",
                mode: "ask",
                revision: 0,
              },
            ],
            approvals: [],
          },
        })
      } else {
        if (input)
          writes.push({
            kind: "library",
            agent: url.searchParams.get("agent"),
            input,
          })
        await route.fulfill({
          json: url.pathname.includes("/connections")
            ? { connections: [connection] }
            : { skills: [skill] },
        })
      }
    }
  )
  return { tool, skill, writes }
}

async function signIn(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
}

async function openChat(page: Page) {
  await signIn(page)
  await page
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: "Navi", exact: true })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
}

async function openSettingsMenu(page: Page, mobile: boolean) {
  if (mobile) {
    await page
      .getByRole("navigation", { name: "Mobile workspace", exact: true })
      .getByRole("button", { name: "Agents", exact: true })
      .click()
    await page
      .getByRole("navigation", { name: "Agents and workspace", exact: true })
      .getByRole("button", { name: "Settings for Bench", exact: true })
      .click()
  } else {
    await page.getByRole("button", { name: /Pi.*Fixture family/ }).click()
  }
}

async function selectSettings(page: Page, name: string, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "All settings", exact: true })
      .click()
  await page
    .getByRole("navigation", { name: "Settings sections", exact: true })
    .getByRole("link", { name: new RegExp(`^${name}`) })
    .click()
}

async function expectPath(page: Page, path: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(path)
}

async function expectNavigation(page: Page, paths: readonly string[]) {
  const navigation = page
    .locator(".workspace-settings")
    .getByRole("navigation", {
      name: "Settings sections",
      exact: true,
      includeHidden: true,
    })
  await expect
    .poll(() =>
      navigation
        .getByRole("link", { includeHidden: true })
        .evaluateAll((links) =>
          links
            .map((link) => new URL((link as HTMLAnchorElement).href).pathname)
            .sort()
        )
    )
    .toEqual([...paths].sort())
}

async function expectGlobalShell(page: Page) {
  const shell = page.locator(".workspace-settings")
  await expect(shell.locator(".agent-mark")).toHaveCount(0)
  await expect(
    shell.locator(".settings-agent").filter({ hasText: /Navi|Research/ })
  ).toHaveCount(0)
  await expect(
    shell.getByRole("button", {
      name: "Edit agent",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await expect(
    shell.getByText("Email this agent", { exact: true })
  ).toHaveCount(0)
  await expect(
    shell.getByRole("region", {
      name: "Selected connected tools",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await expect(
    shell.getByRole("region", {
      name: "Selected skills",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await expectNavigation(
    page,
    destinations.map(({ path }) => path)
  )
}

for (const { path, heading } of destinations) {
  test(`${path} opens without an assistant URL`, async ({ page }) => {
    await mockLibraries(page)
    await signIn(page)
    await page.goto(path)
    await expectPath(page, path)
    await expect(
      page.getByRole("heading", { name: heading, exact: true })
    ).toBeVisible()
    await expectGlobalShell(page)
    const shell = page.locator(".workspace-settings")
    if (path === "/settings/account") {
      await expect(
        shell.getByRole("region", { name: "Your profile photo", exact: true })
      ).toBeVisible()
    } else if (path === "/settings/preferences") {
      await expect(
        shell.getByRole("button", { name: "System", exact: true })
      ).toBeEnabled()
      await expect(
        shell.getByRole("switch", { name: "Interaction sounds", exact: true })
      ).toBeEnabled()
    } else if (path === "/settings/channels") {
      await expect(
        shell.getByRole("combobox", { name: "WhatsApp agent", exact: true })
      ).toBeEnabled()
    }
  })
}

for (const path of [
  "/agents/navi/settings/family",
  "/agents/navi/settings/model-access",
  "/agents/navi/settings/security",
  "/agents/navi/settings/memory",
  "/agents/navi/settings",
]) {
  test(`${path} is rejected without redirecting or opening Home`, async ({
    page,
  }) => {
    await signIn(page)
    await page.goto(workbench)
    await expect(
      page.getByRole("combobox", { name: "Workbench tool" })
    ).toContainText("Files")
    await page.goto(`${path}?panel=files&tab=trash&connections=connected`)
    await expect(
      page.getByRole("heading", {
        name: "Page not found",
        exact: true,
      })
    ).toBeVisible()
    await expectPath(page, path)
    await expect(
      page.getByRole("textbox", {
        name: "Message Navi",
        exact: true,
        includeHidden: true,
      })
    ).toHaveCount(0)
    await expect(
      page.getByRole("heading", {
        name: /^(Family|Model access|Account security|Navi)$/,
      })
    ).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Your agents" })).toHaveCount(
      0
    )
    await page.goBack()
    await expect(page).toHaveURL(/\/agents\/navi\/files\?tab=trash$/)
    await expect(
      page.getByRole("combobox", { name: "Workbench tool" })
    ).toContainText("Files")
  })
}

test("Family through Settings keeps the same unsent composer and attachment through close and history", async ({
  page,
  isMobile,
}) => {
  await openChat(page)
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
    includeHidden: true,
  })
  const draft = "Keep this private draft while I check the family."
  await composer.fill(draft)
  await page.getByLabel("Choose files", { exact: true }).setInputFiles(photo)
  const attachment = page.getByRole("button", {
    name: "Remove route-draft.png from message",
    exact: true,
    includeHidden: true,
  })
  await expect(attachment).toBeVisible()
  const original = await composer.elementHandle()
  let sends = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
  async function preserved() {
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(composer).toHaveValue(draft)
    await expect(attachment).toHaveCount(1)
    expect(sends).toBe(0)
  }
  await openSettingsMenu(page, isMobile)
  await preserved()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expectPath(page, "/settings/account")
  await selectSettings(page, "Family", isMobile)
  await expectPath(page, "/family")
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe("/agents/navi")
  await preserved()
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expectPath(page, "/agents/navi")
  await preserved()
  await page.goBack()
  await expectPath(page, "/family")
  await preserved()
  await page.goBack()
  await expectPath(page, "/settings/account")
  await preserved()
  await page.goForward()
  await expectPath(page, "/family")
  await preserved()
  await page.goForward()
  await expectPath(page, "/agents/navi")
  await preserved()
  await expect(composer).toBeVisible()
  await expect(attachment).toBeVisible()
})

test("global Security is a settings section and closes directly to the workbench", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  await page.goto(
    `/settings/account?${new URLSearchParams({ returnTo: workbench })}`
  )
  await selectSettings(page, "Account security", isMobile)
  await expectPath(page, "/settings/security")
  await expect(
    page.getByRole("heading", { name: "Account security", exact: true })
  ).toBeVisible()
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(workbench)
  await expect(page.locator(".workspace-settings [role=dialog]")).toHaveCount(0)
  await expectGlobalShell(page)
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi\/files\?tab=trash$/)
  await expect(
    page.getByRole("combobox", { name: "Workbench tool" })
  ).toContainText("Files")
})

test("global settings reject external, action, overlay and invalid resource return paths", async ({
  page,
}) => {
  await signIn(page)
  for (const returnTo of [
    "https://example.invalid/agents/navi",
    "//example.invalid/agents/navi",
    "/agents/new",
    "/agents/navi/settings/access",
    "/agents/navi/files?tab=notes",
    "/agents/navi/files#unsafe",
  ]) {
    await page.goto(`/family?${new URLSearchParams({ returnTo })}`)
    await expect(
      page.getByRole("heading", { name: "Family", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click()
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toMatch(/^\/agents(?:\/navi)?$/)
  }
})

test("assistant settings have only assistant controls and five scoped destinations", async ({
  page,
}) => {
  await mockLibraries(page)
  await signIn(page)
  const sections = ["general", "models", "connections", "access", "skills"]
  for (const section of sections) {
    await page.goto(`/agents/navi/settings/${section}`)
    await expectPath(page, `/agents/navi/settings/${section}`)
    await expectNavigation(
      page,
      sections.map((value) => `/agents/navi/settings/${value}`)
    )
    await expect(
      page.locator(".workspace-settings .settings-agent")
    ).toContainText("Navi")
    await expect(
      page.locator(".workspace-settings").getByRole("region", {
        name: "Your profile photo",
        includeHidden: true,
      })
    ).toHaveCount(0)
    const shell = page.locator(".workspace-settings")
    await expect(
      shell.getByRole("heading", {
        name: "Appearance",
        exact: true,
        includeHidden: true,
      })
    ).toHaveCount(0)
    await expect(
      shell.getByRole("heading", {
        name: "Account security",
        exact: true,
        includeHidden: true,
      })
    ).toHaveCount(0)
    await expect(
      shell.getByRole("switch", {
        name: "Interaction sounds",
        exact: true,
        includeHidden: true,
      })
    ).toHaveCount(0)
    if (section === "general") {
      await expect(
        shell.getByRole("heading", { name: "General", exact: true })
      ).toBeVisible()
      await expect(
        shell.getByRole("button", { name: "Edit agent", exact: true })
      ).toBeEnabled()
    } else if (section === "models") {
      await expect(
        shell.getByRole("heading", {
          name: "Defaults for this agent",
          exact: true,
        })
      ).toBeVisible()
    } else if (section === "access") {
      await expect(
        shell
          .getByRole("group", {
            name: "Access for Read browser page",
            exact: true,
          })
          .getByRole("button", { name: "Ask", exact: true })
      ).toHaveAttribute("aria-pressed", "true")
    } else {
      await expect(
        shell.getByRole("region", {
          name:
            section === "connections"
              ? "Selected connected tools"
              : "Selected skills",
          exact: true,
        })
      ).toBeVisible()
    }
  }
})

test("global libraries manage connections and skill revisions without assistant assignment", async ({
  page,
}) => {
  const fixture = await mockLibraries(page)
  await signIn(page)
  await page.goto("/settings/connections")
  await expectGlobalShell(page)
  const shell = page.locator(".workspace-settings")
  await expect(
    shell.getByRole("heading", { name: "Calendar service", exact: true })
  ).toBeVisible()
  await expect(
    shell.getByRole("button", { name: "Disconnect", exact: true })
  ).toBeEnabled()
  await expect(
    shell.getByRole("button", { name: "Add", exact: true, includeHidden: true })
  ).toHaveCount(0)
  await shell
    .getByRole("button", { name: "Add connection", exact: true })
    .click()
  await expect(shell.getByLabel("MCP endpoint", { exact: true })).toBeEditable()
  await shell.getByRole("button", { name: "Cancel", exact: true }).click()
  await page.goto("/settings/skills")
  await expectGlobalShell(page)
  await expect(
    shell.getByRole("heading", { name: fixture.skill.name, exact: true })
  ).toBeVisible()
  await expect(
    shell.getByRole("button", { name: "New", exact: true })
  ).toBeEnabled()
  await expect(
    shell.getByRole("button", { name: "Import", exact: true })
  ).toBeEnabled()
  await expect(
    shell.getByRole("button", {
      name: "Use for this assistant",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await shell.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(shell.getByLabel("Instructions", { exact: true })).toHaveValue(
    fixture.skill.body
  )
  await expect(
    shell.getByRole("button", { name: "Save skill", exact: true })
  ).toBeEnabled()
  await shell.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(fixture.writes).toEqual([])
})

test("family members retain global account settings without channel administration", async ({
  page,
}) => {
  await page.route("**/api/family", async (route) => {
    const response = await route.fetch()
    const family = await response.json()
    await route.fulfill({ response, json: { ...family, role: "member" } })
  })
  await signIn(page)
  await page.goto("/settings/account")
  await expect(
    page.getByRole("region", { name: "Your profile photo", exact: true })
  ).toBeVisible()
  await expectNavigation(
    page,
    destinations
      .filter(({ path }) => path !== "/settings/channels")
      .map(({ path }) => path)
  )
  await page.goto("/settings/channels")
  await expect(
    page.getByText("Only the family admin can manage channels.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("combobox", { name: "WhatsApp agent", exact: true })
  ).toHaveCount(0)
})

test("assistant connection and skill assignments save only to the selected assistant", async ({
  page,
}) => {
  await addResearch(page)
  const fixture = await mockLibraries(page)
  await signIn(page)
  const shell = page.locator(".workspace-settings")
  await page.goto("/agents/research/settings/connections")
  await expect(shell.locator(".settings-agent")).toContainText("Research")
  await expect(
    shell.getByRole("heading", { name: "Calendar service", exact: true })
  ).toBeVisible()
  await expect(
    shell.getByRole("button", {
      name: /^(Add connection|Connect Executor|Reconnect|Disconnect)$/,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await shell.getByText("Choose tools · 1", { exact: true }).click()
  await shell.getByRole("button", { name: "Add", exact: true }).click()
  await expect(
    shell.getByRole("region", { name: "Selected connected tools", exact: true })
  ).toContainText(fixture.tool.remoteName)
  await page.goto("/agents/research/settings/skills")
  await expect(
    shell.getByRole("heading", { name: fixture.skill.name, exact: true })
  ).toBeVisible()
  await expect(
    shell.getByRole("button", {
      name: /^(New|Import|Edit|Archive|Restore)$/,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await shell
    .getByRole("button", { name: "Use for this assistant", exact: true })
    .click()
  await expect(
    shell.getByRole("region", { name: "Selected skills", exact: true })
  ).toContainText(fixture.skill.name)
  expect(fixture.writes).toEqual([
    {
      kind: "tools",
      agent: research.id,
      input: { expectedRevision: 0, names: [fixture.tool.name] },
    },
    {
      kind: "skills",
      agent: research.id,
      input: {
        expectedRevision: 0,
        skills: [{ id: fixture.skill.id, revision: fixture.skill.revision }],
      },
    },
  ])
})

test("mobile Family invitation stays a nested sheet and dismisses back to the workbench", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile sheet nesting")
  await signIn(page)
  await page.goto(`/family?${new URLSearchParams({ returnTo: workbench })}`)
  await expect(page.locator(".workspace-settings")).toHaveAttribute(
    "data-overlay-mobile",
    "true"
  )
  await page
    .getByRole("button", { name: "Invite someone", exact: true })
    .click()
  const invitation = page.getByRole("dialog", {
    name: "Invite someone",
    exact: true,
  })
  await expect(invitation).toBeVisible()
  await expect(invitation).toHaveAttribute("data-overlay-mobile", "true")
  await invitation
    .getByLabel("Email address", { exact: true })
    .fill("unsent@example.invalid")
  const bounds = await invitation.boundingBox()
  expect(bounds).not.toBeNull()
  expect(bounds!.x).toBeGreaterThanOrEqual(0)
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
  await page.keyboard.press("Escape")
  await expect(invitation).not.toBeVisible()
  await expectPath(page, "/family")
  await expect(
    page.getByRole("heading", { name: "Family", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi\/files\?tab=trash$/)
  await expect(
    page.getByRole("dialog", { name: "Navi workbench", exact: true })
  ).toHaveAttribute("data-overlay-mobile", "true")
})

test("global Family remains usable while the known assistant's SSE request is pending", async ({
  page,
}) => {
  let requested = false
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/agent/events?**", async (route) => {
    requested = true
    await pending
    await route.abort().catch(() => {})
  })
  try {
    await signIn(page)
    await page.goto(
      `/family?${new URLSearchParams({ returnTo: "/agents/navi" })}`
    )
    await expect.poll(() => requested).toBe(true)
    await expect(
      page.getByRole("heading", { name: "Family", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Close settings", exact: true })
    ).toBeEnabled()
  } finally {
    release()
    await page.unrouteAll({ behavior: "wait" })
  }
})

for (const section of ["account", "security"]) {
  test(`direct global ${section} opens before the catalog and retains its input after catalog arrival`, async ({
    page,
  }) => {
    await signIn(page)
    let requested = false
    let release!: () => void
    const catalog = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route("**/api/agent/bots", async (route) => {
      requested = true
      await catalog
      const response = await route.fetch()
      await route.fulfill({ response })
    })
    await page.route(
      (url) =>
        [
          "/api/auth/list-sessions",
          "/api/auth/passkey/list-user-passkeys",
        ].includes(url.pathname),
      (route) => route.fulfill({ json: [] })
    )
    let streams = 0
    let factorMutations = 0
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path === "/api/agent/events") streams++
      if (request.method() === "POST" && path.includes("/two-factor/"))
        factorMutations++
    })
    try {
      await page.goto(`/settings/${section}`)
      await expect.poll(() => requested).toBe(true)
      await expect(
        page.getByRole("heading", {
          name: section === "account" ? "Account" : "Account security",
          exact: true,
        })
      ).toBeVisible()
      if (section === "security")
        await page
          .getByRole("button", { name: "Set up two-factor", exact: true })
          .click()
      const field = page.getByLabel(
        section === "account" ? "Choose a photo" : "Current password",
        { exact: true }
      )
      await expect(field).toBeEnabled()
      const draft = "Unsubmitted security setup draft"
      if (section === "security") await field.fill(draft)
      else await expect(field).toHaveAttribute("type", "file")
      const original = await field.elementHandle()
      expect(streams).toBe(0)
      // The status read starts only after React has consumed the catalog.
      const applied = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/agent/bots/statuses" &&
          response.ok()
      )
      release()
      await applied
      expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
      await expect(field).toBeEnabled()
      if (section === "security") await expect(field).toHaveValue(draft)
      else await expect(field).toHaveAttribute("type", "file")
      expect(streams).toBe(0)
      expect(factorMutations).toBe(0)
      await expectPath(page, `/settings/${section}`)
    } finally {
      release()
      await page.unrouteAll({ behavior: "wait" })
    }
  })
}

test("global Family canonicalizes an ID backdrop without losing its search", async ({
  page,
}) => {
  await signIn(page)
  await page.goto(
    `/family?${new URLSearchParams({ returnTo: "/agents/home?q=Studio" })}`
  )
  await expect(
    page.getByRole("heading", { name: "Family", exact: true })
  ).toBeVisible()
  await expect
    .poll(() => new URL(page.url()).searchParams.get("returnTo"))
    .toBe("/agents/navi?q=Studio")
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expectPath(page, "/agents/navi")
  expect(new URL(page.url()).searchParams.get("q")).toBe("Studio")
})

for (const reference of ["missing-assistant", "research"]) {
  test(`an explicit ${reference} backdrop keeps global settings usable without substituting Home`, async ({
    page,
  }) => {
    await addResearch(page, "archived")
    await signIn(page)
    const returnTo = `/agents/${reference}`
    await page.goto(`/family?${new URLSearchParams({ returnTo })}`)
    await expect(
      page.getByRole("heading", { name: "Family", exact: true })
    ).toBeVisible()
    await expect(
      page.getByText("Your workspace is unavailable.", { exact: true })
    ).toBeVisible()
    await expectGlobalShell(page)
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTo)
    await expect(
      page.getByRole("textbox", {
        name: "Message Navi",
        exact: true,
        includeHidden: true,
      })
    ).toHaveCount(0)
    await page
      .getByRole("button", { name: "Model access", exact: true })
      .click()
    await expectPath(page, "/family/model-access")
    await expect(
      page.getByRole("heading", { name: "Model access", exact: true })
    ).toBeVisible()
    expect(new URL(page.url()).searchParams.get("returnTo")).toBe(returnTo)
  })
}

test("a non-default assistant keeps its mounted composer and file draft through global Family", async ({
  page,
  isMobile,
}) => {
  await addResearch(page)
  await signIn(page)
  await page
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: "Research", exact: true })
    .click()
  await expectPath(page, "/agents/research")
  const composer = page.getByRole("textbox", {
    name: "Message Research",
    exact: true,
    includeHidden: true,
  })
  const draft = "Keep this research draft with its original assistant."
  await composer.fill(draft)
  await page.getByLabel("Choose files", { exact: true }).setInputFiles(photo)
  const attachment = page.getByRole("button", {
    name: "Remove route-draft.png from message",
    exact: true,
    includeHidden: true,
  })
  await expect(attachment).toBeVisible()
  const original = await composer.elementHandle()
  let sends = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
  await openSettingsMenu(page, isMobile)
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(composer).toHaveValue(draft)
  await expect(attachment).toHaveCount(1)
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await selectSettings(page, "Family", isMobile)
  await expectPath(page, "/family")
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/agents/research"
  )
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(composer).toHaveValue(draft)
  await expect(attachment).toHaveCount(1)
  await expect(
    page.getByRole("textbox", {
      name: "Message Navi",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expectPath(page, "/agents/research")
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue(draft)
  await expect(attachment).toBeVisible()
  expect(sends).toBe(0)
})

test("a ready terminal keeps its command draft and renews its lease through global Family", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Mobile sheet nesting is covered separately")
  await addResearch(page)
  let renewals = 0
  const unexpected: string[] = []
  await page.route(
    (url) =>
      url.pathname === "/api/agent/terminal" ||
      url.pathname.startsWith("/api/agent/terminal/"),
    async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      expect(url.searchParams.get("agent")).toBe(research.id)
      if (
        request.method() === "GET" &&
        url.pathname === "/api/agent/terminal"
      ) {
        await route.fulfill({
          json: {
            runs: [],
            savedAt: null,
            busy: true,
            cleanupError: null,
            networkPolicy: { revision: 0, unrestricted: false },
            session: {
              id: "route-session",
              phase: "ready",
              expiresAt: Date.now() + 30_000,
              maximumAt: Date.now() + 600_000,
            },
          },
        })
      } else if (
        request.method() === "POST" &&
        url.pathname === "/api/agent/terminal/session/route-session/renew"
      ) {
        renewals++
        await route.fulfill({ json: { expiresAt: Date.now() + 30_000 } })
      } else {
        unexpected.push(`${request.method()} ${url.pathname}`)
        await route.fulfill({
          status: 409,
          json: { error: "Unexpected terminal action" },
        })
      }
    }
  )
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      unexpected.push("Send message")
  })
  await signIn(page)
  await page.goto("/agents/research/terminal")
  await expect(
    page.getByRole("tab", { name: "Commands", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  const command = page.getByRole("textbox", {
    name: "Shell command",
    exact: true,
    includeHidden: true,
  })
  const draft = "printf 'Retain this local terminal draft'"
  await command.fill(draft)
  await expect(
    page.getByRole("button", { name: "Run command", exact: true })
  ).toBeDisabled()
  await expect.poll(() => renewals).toBeGreaterThanOrEqual(1)
  const original = await command.elementHandle()
  await openSettingsMenu(page, false)
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await selectSettings(page, "Family", false)
  await expectPath(page, "/family")
  expect(new URL(page.url()).searchParams.get("returnTo")).toBe(
    "/agents/research/terminal"
  )
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(command).toHaveValue(draft)
  const previous = renewals
  await expect
    .poll(() => renewals, { timeout: 15_000 })
    .toBeGreaterThan(previous)
  expect(renewals).toBeGreaterThanOrEqual(2)
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(command).toHaveValue(draft)
  await page
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expectPath(page, "/agents/research/terminal")
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(command).toBeVisible()
  await expect(command).toHaveValue(draft)
  expect(unexpected).toEqual([])
})
