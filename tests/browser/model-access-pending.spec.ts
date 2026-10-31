import { expect, test, type Page } from "@playwright/test"

import { closeSettings, settingsFront, settingsRoot } from "./settings-helpers"

const attempt = {
  id: "pending-guard-attempt",
  email: "owner@example.invalid",
  expiresAt: Date.now() + 600_000,
  authorizationUrl: "https://example.invalid/synthetic-sign-in",
}
const address =
  "http://127.0.0.1:53000/auth/callback?code=synthetic-code&state=synthetic-state"

async function openModelAccess(page: Page) {
  await page.route("**/api/family", (route) =>
    route.fulfill({
      json: {
        id: "family",
        name: "Fixture family",
        role: "owner",
        ownerName: "Fixture owner",
        members: [
          {
            id: "family-owner",
            userId: "fixture-owner",
            name: "Fixture owner",
            email: attempt.email,
            role: "owner",
          },
        ],
        invitations: [],
      },
    })
  )
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.goto("/family/model-access")
  await expect(page.getByLabel("Return address", { exact: true })).toBeVisible()
}

test("a return-address draft blocks settings dismissal until explicitly discarded", async ({
  page,
  isMobile,
}) => {
  const writes: unknown[] = []
  await page.route("**/api/agent/model-account?*", (route) => {
    if (route.request().method() === "POST") {
      writes.push(route.request().postDataJSON())
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected mutation" },
      })
    }
    return route.fulfill({ json: { pending: attempt } })
  })
  await openModelAccess(page)
  const close = settingsFront(page).getByRole("button", {
    name: isMobile ? "Close Model access" : "Close settings",
    exact: true,
  })
  const field = page.getByLabel("Return address", { exact: true })
  await field.fill(address)
  await expect(close).toBeDisabled()
  await expect(
    settingsFront(page).getByText(
      "Finish or cancel your changes before leaving this section.",
      {
        exact: true,
      }
    )
  ).toBeVisible()
  if (isMobile) {
    await expect(
      settingsFront(page).getByRole("button", {
        name: "Back to Family",
        exact: true,
      })
    ).toBeDisabled()
    await expect(
      settingsRoot(page).getByRole("button", {
        name: "Close settings",
        exact: true,
        includeHidden: true,
      })
    ).toBeDisabled()
  }
  await page.keyboard.press("Escape")
  await expect(page).toHaveURL(/\/family\/model-access$/)
  await expect(field).toHaveValue(address)
  await page
    .getByRole("button", { name: "Discard return address", exact: true })
    .click()
  await expect(field).toHaveValue("")
  await expect(close).toBeEnabled()
  await closeSettings(page)
  await expect(page).toHaveURL(/\/agents$/)
  expect(writes).toEqual([])
})

test("a reconnect request stays guarded through an unresolved error without retrying on dismissal", async ({
  page,
  isMobile,
}) => {
  const writes: unknown[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/agent/model-account?*", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { pending: attempt } })
    writes.push(route.request().postDataJSON())
    await held
    return route.fulfill({
      status: 503,
      json: { error: "Synthetic connection result is unconfirmed." },
    })
  })
  try {
    await openModelAccess(page)
    const close = settingsFront(page).getByRole("button", {
      name: isMobile ? "Close Model access" : "Close settings",
      exact: true,
    })
    await page.getByLabel("Return address", { exact: true }).fill(address)
    await page
      .getByRole("button", { name: "Finish connection", exact: true })
      .click()
    await expect.poll(() => writes.length).toBe(1)
    await expect(close).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Connecting…", exact: true })
    ).toBeDisabled()
    release()
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "Synthetic connection result is unconfirmed." })
    ).toBeVisible()
    await expect(close).toBeDisabled()
    await page
      .getByRole("button", { name: "Dismiss error", exact: true })
      .click()
    await expect(close).toBeEnabled()
    await closeSettings(page)
    await expect(page).toHaveURL(/\/agents$/)
    expect(writes).toEqual([{ action: "finish", id: attempt.id, address }])
  } finally {
    release()
    await page.unrouteAll({ behavior: "wait" })
  }
})
