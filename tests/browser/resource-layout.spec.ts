import { expect, test } from "@playwright/test"

const id = "44444444-4444-4444-8444-444444444444"

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
