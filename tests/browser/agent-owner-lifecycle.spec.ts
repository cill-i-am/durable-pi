import { expect, test, type Page } from "@playwright/test"

async function signIn(page: Page, path = "/agents/new") {
  await page.goto(path)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}

test("a held agent save retains newer edits and uses update after acknowledged creation", async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: {
    path: string
    id: string
    name: string
    instructions: string
  }[] = []
  let created: Record<string, unknown> | null = null
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      json: {
        ...body,
        agents: [...body.agents, ...(created ? [created] : [])],
      },
    })
  })
  await page.route(/\/api\/agent\/bots\/(create|update)$/, async (route) => {
    const input = route.request().postDataJSON()
    writes.push({ path: new URL(route.request().url()).pathname, ...input })
    if (writes.length === 1) await held
    created = {
      ...input,
      slug: "held-agent",
      status: "active",
      revision: writes.length,
      createdAt: "2026-10-23T00:00:00Z",
      updatedAt: "2026-10-23T00:00:00Z",
    }
    await route.fulfill({ json: created })
  })
  await signIn(page, "/agents")
  await page.getByRole("button", { name: "New agent", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill("First name")
  await page.getByLabel("Purpose", { exact: true }).fill("First purpose")
  await page.getByRole("button", { name: "Create agent", exact: true }).click()
  await expect.poll(() => writes.length).toBe(1)
  await page.getByLabel("Name", { exact: true }).fill("Newer name")
  await page.getByLabel("Purpose", { exact: true }).fill("Newer purpose")
  await page.evaluate(() => window.history.back())
  await expect(page).toHaveURL(/\/agents\/new/)
  await expect(
    page.getByText("Finish or cancel the open edit before leaving this view.", {
      exact: true,
    })
  ).toBeAttached()
  release()
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "Newer name"
  )
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({
    path: "/api/agent/bots/update",
    id: writes[0]!.id,
    name: "Newer name",
    instructions: "Newer purpose",
  })
  await expect(page.getByLabel("Name", { exact: true })).not.toBeVisible()
})

test("an acknowledged agent save retries only its failed catalog refresh", async ({
  page,
}) => {
  let writes = 0,
    readsAfterSave = 0
  let created: Record<string, unknown> | null = null
  await page.route("**/api/agent/bots", async (route) => {
    if (created && ++readsAfterSave === 1)
      return route.fulfill({
        status: 503,
        json: { error: "Synthetic catalog outage" },
      })
    const response = await route.fetch()
    const body = await response.json()
    return route.fulfill({
      json: {
        ...body,
        agents: [...body.agents, ...(created ? [created] : [])],
      },
    })
  })
  await page.route("**/api/agent/bots/create", (route) => {
    writes++
    created = {
      ...route.request().postDataJSON(),
      slug: "acknowledged-agent",
      status: "active",
      revision: 1,
      createdAt: "today",
      updatedAt: "today",
    }
    return route.fulfill({ json: created })
  })
  await signIn(page)
  await page.getByLabel("Name", { exact: true }).fill("Acknowledged agent")
  await page.getByRole("button", { name: "Create agent", exact: true }).click()
  await page
    .getByRole("button", { name: "Refresh agent list", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/acknowledged-agent$/)
  expect(writes).toBe(1)
  expect(readsAfterSave).toBe(2)
})

test("restore holds navigation until the request settles and retains capacity errors", async ({
  page,
}) => {
  const archived = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    slug: "archived-agent",
    name: "Archived agent",
    instructions: "Keep my saved work",
    status: "archived",
    revision: 1,
    createdAt: "today",
    updatedAt: "today",
  }
  let writes = 0,
    release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    return route.fulfill({
      json: { ...body, agents: [...body.agents, archived] },
    })
  })
  await page.route("**/api/agent/bots/archive", async (route) => {
    writes++
    await held
    return route.fulfill({
      status: 409,
      json: {
        error:
          "Archive a bot before creating or restoring another. You can have 32 active bots.",
      },
    })
  })
  await signIn(page, "/agents/archived")
  await page
    .getByRole("button", { name: "Restore Archived agent", exact: true })
    .click()
  await expect.poll(() => writes).toBe(1)
  await page.getByRole("link", { name: "Active agents", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/archived$/)
  await expect(
    page.getByText("Finish or cancel the open edit before leaving this view.", {
      exact: true,
    })
  ).toBeVisible()
  release()
  await expect(
    page.getByRole("alert").filter({
      hasText:
        "Archive a bot before creating or restoring another. You can have 32 active bots.",
    })
  ).toBeVisible()
  await expect(
    page.getByText("Keep my saved work", { exact: true })
  ).toBeVisible()
  expect(writes).toBe(1)
  await page.getByRole("link", { name: "Active agents", exact: true }).click()
  await expect(page).toHaveURL(/\/agents$/)
})
