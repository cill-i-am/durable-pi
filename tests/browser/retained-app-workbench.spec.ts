import { expect, test, type Page } from "@playwright/test"

import type { AppDocument } from "../../src/apps/contracts"

const app: AppDocument = {
  id: "11111111-1111-4111-8111-111111111111",
  version: 1,
  revision: 1,
  publishedVersion: 1,
  archived: false,
  createdAt: "2026-10-31",
  state: { checks: {}, forms: {} },
  definition: {
    title: "Retention proof",
    description: "Synthetic local form",
    blocks: [
      {
        id: "form",
        type: "form",
        title: "Details",
        submitLabel: "Save form",
        fields: [
          { id: "name", label: "Name", required: false, multiline: false },
        ],
      },
    ],
  },
}

async function selectTab(page: Page, name: string, mobile: boolean) {
  if (mobile) {
    await page.getByRole("button", { name: /^Open tabs \(/ }).click()
    await page
      .getByRole("dialog", { name: "Open tabs", exact: true })
      .getByRole("button", { name, exact: true })
      .click()
    await expect(
      page.getByRole("dialog", { name: "Open tabs", exact: true })
    ).toHaveCount(0)
  } else await page.getByRole("tab", { name, exact: true }).click()
  await expect(page.getByRole("tabpanel", { name, exact: true })).toBeVisible()
}

test("an unsent app form retains its exact DOM across tool switches and hide until its tab closes", async ({
  page,
  isMobile,
}) => {
  let writes = 0
  await page.route("**/api/agent/apps**", async (route) => {
    if (route.request().method() !== "GET") writes++
    const path = new URL(route.request().url()).pathname
    return route.fulfill({
      json:
        path === "/api/agent/apps"
          ? { apps: [app] }
          : { app, versions: [app], events: [] },
    })
  })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Assistants", exact: true })
  ).toBeVisible()
  await page.goto(`/agents/navi/apps/${app.id}`)
  const field = page.getByLabel("Name", { exact: true })
  await expect(field).toBeEnabled()
  await field.fill("Keep this unsent app field")
  const original = await field.elementHandle()
  expect(original).not.toBeNull()
  const retained = async () => {
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(field).toHaveValue("Keep this unsent app field")
    expect(writes).toBe(0)
  }
  await retained()
  await page.getByRole("button", { name: "Open a tool", exact: true }).click()
  await page.getByRole("menuitem", { name: "Files", exact: true }).click()
  await expect(
    page.getByRole("tabpanel", { name: "Files", exact: true })
  ).toBeVisible()
  await retained()
  await selectTab(page, "Apps", isMobile)
  await retained()
  await page
    .getByRole("button", { name: "Hide workbench", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Open workbench", exact: true })
  ).toBeVisible()
  await retained()
  await page
    .getByRole("button", { name: "Open workbench", exact: true })
    .click()
  // Reopening selects the frame's default tool. The retained app must survive
  // both the hidden interval and restoring its own tab.
  await retained()
  await selectTab(page, "Apps", isMobile)
  await retained()
  await page
    .getByRole("button", { name: "Close Apps tab", exact: true })
    .click()
  await expect
    .poll(() => original!.evaluate((node) => node.isConnected))
    .toBe(false)
  await expect(
    page.getByRole("tabpanel", { name: "Files", exact: true })
  ).toBeVisible()
  expect(writes).toBe(0)
})
