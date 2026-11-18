import { expect, test } from "@playwright/test"

const id = "44444444-4444-4444-8444-444444444444"

test("manual execution starts with empty drafts and terminal tabs fit one row", async ({
  page,
  isMobile,
}) => {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.goto("/agents/navi/code")
  await expect(page.getByLabel("JavaScript", { exact: true })).toBeEmpty()
  await expect(page.getByLabel("Input JSON", { exact: true })).toHaveValue(
    "null"
  )
  await expect(
    page.getByRole("button", { name: "Run code", exact: true })
  ).toBeDisabled()
  await expect(
    page
      .locator(".execution-workbench > header")
      .getByText("JavaScript", { exact: true })
  ).toHaveCount(0)
  await page.goto("/agents/navi/terminal")
  await expect(page.getByLabel("Shell command", { exact: true })).toBeEmpty()
  await expect(
    page.getByRole("button", { name: "Run command", exact: true })
  ).toBeDisabled()
  for (const width of isMobile ? [390, 320] : [1280, 800, 768]) {
    await page.setViewportSize({ width, height: 900 })
    const bounds = []
    for (const name of ["Commands", "Interactive", "Transfers"]) {
      const tab = page.getByRole("tab", { name, exact: true })
      await expect(tab).toBeVisible()
      const box = (await tab.boundingBox())!
      bounds.push(box)
      expect(box.width).toBeGreaterThanOrEqual(44)
      if (isMobile) expect(box.height).toBeGreaterThanOrEqual(44)
    }
    expect(
      Math.max(...bounds.map((box) => box.y)) -
        Math.min(...bounds.map((box) => box.y))
    ).toBeLessThan(1)
    expect(bounds.at(-1)!.x + bounds.at(-1)!.width).toBeLessThanOrEqual(width)
  }
})

test("long app forms scroll to their action while workbench controls stay visible", async ({
  page,
}) => {
  const writes: string[] = []
  const app = {
    id,
    version: 1,
    revision: 1,
    publishedVersion: 1,
    archived: false,
    createdAt: "2026-10-31",
    state: { checks: {}, forms: {} },
    definition: {
      title: "Long form",
      description: "",
      blocks: [
        {
          id: "details",
          type: "form",
          title: "Details",
          submitLabel: "Save details",
          fields: Array.from({ length: 8 }, (_, index) => ({
            id: `field${index}`,
            label: `Field ${index + 1}`,
            required: false,
            multiline: true,
          })),
        },
      ],
    },
  }
  await page.route("**/api/agent/apps**", async (route) => {
    if (route.request().method() !== "GET") {
      writes.push(route.request().url())
      await route.abort()
      return
    }
    const url = new URL(route.request().url())
    await route.fulfill({
      json: url.pathname.endsWith("/apps")
        ? { apps: [app] }
        : { app, versions: [app], events: [] },
    })
  })
  await page.goto(`/agents/navi/apps/${id}`)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Long form", exact: true })
  ).toBeVisible()
  const body = page.locator(".apps-workbench-body")
  await expect
    .poll(() =>
      body.evaluate((element) => element.scrollHeight > element.clientHeight)
    )
    .toBe(true)
  await body.hover()
  await page.mouse.wheel(0, 2000)
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0)
  const action = page.getByRole("button", { name: "Save details", exact: true })
  await expect(action).toBeInViewport({ ratio: 1 })
  await expect(
    page.getByRole("button", { name: "Open a tool", exact: true })
  ).toBeInViewport({ ratio: 1 })
  expect(writes).toEqual([])
})

test("routine read failures keep unknown data distinct from an empty list", async ({
  page,
}) => {
  let available = false
  const writes: string[] = []
  await page.route("**/api/agent/routines?**", async (route) => {
    if (route.request().method() !== "GET")
      writes.push(route.request().method())
    await route.fulfill(
      available
        ? { json: { routines: [], runs: [] } }
        : { status: 503, json: { error: "Synthetic routine read failure" } }
    )
  })
  await page.goto("/agents/navi/routines")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const panel = page.getByRole("tabpanel", { name: "Routines", exact: true })
  const retry = panel.getByRole("button", {
    name: "Retry routines",
    exact: true,
  })
  await expect(retry).toBeVisible()
  await expect(
    panel.getByRole("heading", { name: "No routines yet", exact: true })
  ).toHaveCount(0)
  await expect(
    panel.getByRole("heading", { name: "Recent runs", exact: true })
  ).toHaveCount(0)
  available = true
  await retry.click()
  await expect(
    panel.getByRole("heading", { name: "No routines yet", exact: true })
  ).toBeVisible()
  await expect(
    panel.getByRole("heading", { name: "Recent runs", exact: true })
  ).toBeVisible()
  await expect(retry).toHaveCount(0)
  expect(writes).toEqual([])
})

test("routine timing guidance follows the selected schedule", async ({
  page,
}) => {
  await page.goto("/agents/navi/routines")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page.getByRole("button", { name: "New routine", exact: true }).click()
  const explanation = page.getByText(
    "Repeats use elapsed time, including across clock changes.",
    { exact: false }
  )
  await expect(explanation).toHaveCount(0)
  await page.getByRole("button", { name: "Repeat", exact: true }).click()
  await expect(explanation).toBeVisible()
  await page.getByRole("button", { name: "Events", exact: true }).click()
  await expect(explanation).toHaveCount(0)
})
