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
  { path: "/family", heading: "Family" },
  {
    path: "/family/model-access",
    heading: "Model access",
  },
  {
    path: "/settings/security",
    heading: "Account security",
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

for (const { path, heading } of destinations) {
  test(`${path} opens without an assistant URL`, async ({ page }) => {
    await signIn(page)
    await page.goto(path)
    await expectPath(page, path)
    await expect(
      page.getByRole("heading", { name: heading, exact: true })
    ).toBeVisible()
  })
}

for (const path of [
  "/agents/navi/settings/family",
  "/agents/navi/settings/model-access",
  "/agents/navi/settings/security",
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
  await expectPath(page, "/agents/navi/settings/general")
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
  await expectPath(page, "/agents/navi/settings/general")
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

test("global security closes to General, then restores the original workbench", async ({
  page,
}) => {
  await signIn(page)
  await page.goto(
    `/settings/security?${new URLSearchParams({ returnTo: workbench })}`
  )
  await expect(
    page.getByRole("heading", { name: "Account security", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expectPath(page, "/agents/navi/settings/general")
  const query = new URL(page.url()).searchParams
  expect(query.get("panel")).toBe("files")
  expect(query.get("tab")).toBe("trash")
  await expect(
    page.getByRole("heading", { name: "General", exact: true })
  ).toBeVisible()
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

test("existing assistant settings stay agent-owned when leaving a global section", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  await page.goto(
    `/family?${new URLSearchParams({ returnTo: "/agents/navi" })}`
  )
  await page.getByRole("button", { name: "Model access", exact: true }).click()
  await expectPath(page, "/family/model-access")
  for (const [name, section] of [
    ["Agents & tools", "access"],
    ["Skills", "skills"],
    ["Models & connections", "models"],
    ["Memory & data", "memory"],
    ["General", "general"],
  ]) {
    await selectSettings(page, name!, isMobile)
    await expectPath(page, `/agents/navi/settings/${section}`)
  }
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
    await expect(page.locator(".settings-agent")).toHaveText("Settings")
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
