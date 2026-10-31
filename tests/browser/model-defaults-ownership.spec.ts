import { expect, test, type Page } from "@playwright/test"

const model = "gpt-6.1-sol"
const catalog = (thinking = "medium", settingsRevision = 0) => ({
  models: [
    {
      id: model,
      name: "Sol",
      thinking: ["low", "medium", "high"],
      input: ["text", "image"],
      tools: true,
      contextWindow: 100000,
      unavailable: null,
    },
  ],
  checkedAt: "2026-10-23T00:00:00.000Z",
  error: null,
  usage: "ChatGPT plan usage",
  selection: { model, thinking, settingsRevision },
  assignments: {
    conversation: {
      model,
      thinking,
      job: "conversation",
      profile: "auto",
      policyVersion: "jobs-v1",
      reason: "agent setting",
    },
  },
})
async function openDefaults(page: Page) {
  await page.goto("/agents/home/settings/models")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("combobox", { name: "Job", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Default model", exact: true })
  ).toBeVisible()
  await page
    .getByRole("combobox", { name: "Reasoning effort", exact: true })
    .click()
  await page.getByRole("option", { name: "high", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save default", exact: true })
  ).toBeEnabled()
}

test("model default Save admits one write and retains acknowledgement across catalog failure", async ({
  page,
}) => {
  let release!: () => void,
    writes = 0,
    failRefresh = false
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/agent/models?*", (route) =>
    route.fulfill(
      failRefresh
        ? { status: 503, json: { error: "Synthetic catalog failure" } }
        : { json: catalog() }
    )
  )
  await page.route("**/api/agent/settings?*", async (route) => {
    writes++
    expect(route.request().postDataJSON()).toEqual({
      model,
      thinking: "high",
      job: "conversation",
    })
    await held
    failRefresh = true
    await route.fulfill({
      json: { model, thinking: "high", settingsRevision: 1 },
    })
  })
  try {
    await openDefaults(page)
    await expect(
      page.getByRole("button", { name: "Save default", exact: true })
    ).toBeEnabled()
    await page
      .getByRole("button", { name: "Save default", exact: true })
      .evaluate((button) => {
        if (!(button instanceof HTMLButtonElement))
          throw new Error("Save control must be a button")
        button.click()
        button.click()
      })
    await expect.poll(() => writes).toBe(1)
    await expect(
      page.getByRole("button", { name: "Saving…", exact: true })
    ).toBeDisabled()
    release()
    await expect(page.getByRole("alert")).toContainText(
      "Default saved, but availability could not refresh. Refresh to check current settings."
    )
    await expect(page.getByText("Saved", { exact: true })).toBeVisible()
    await page
      .getByRole("button", { name: "Reload models", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Save default", exact: true })
    ).toBeDisabled()
    expect(writes).toBe(1)
  } finally {
    release()
  }
})

test("an unconfirmed default uses an explicit read before any reapply", async ({
  page,
}) => {
  let writes = 0,
    reads = 0,
    intended = false
  await page.route("**/api/agent/models?*", (route) => {
    reads++
    return route.fulfill({ json: intended ? catalog("high", 1) : catalog() })
  })
  await page.route("**/api/agent/settings?*", (route) => {
    writes++
    intended = true
    return route.abort("failed")
  })
  await openDefaults(page)
  await page.getByRole("button", { name: "Save default", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Check saved default", exact: true })
  ).toBeEnabled()
  const before = reads
  expect(writes).toBe(1)
  await page
    .getByRole("button", { name: "Check saved default", exact: true })
    .click()
  await expect.poll(() => reads).toBeGreaterThan(before)
  await expect(page.getByText("Saved", { exact: true })).toBeVisible()
  expect(writes).toBe(1)
})
