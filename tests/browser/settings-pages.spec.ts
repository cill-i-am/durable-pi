import { expect, test, type Page } from "@playwright/test"

import { closeSettings, settingsFront } from "./settings-helpers"

async function signIn(page: Page) {
  await page.goto("/agents/navi")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Message Navi" })
  ).toBeVisible()
}

test("desktop settings are non-modal pages inside the shell and retain the chat draft", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Mobile retains the stacked drawer flow")
  await signIn(page)
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await composer.fill("Keep this conversation draft")
  const chatHeight = (await page.locator(".chat-workspace").boundingBox())!
    .height
  const original = await composer.elementHandle()
  await page
    .getByRole("button", { name: "Account menu for Bench", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(page).toHaveURL(/\/settings\/account\?returnTo=/)
  const front = settingsFront(page)
  await expect(front).toHaveAttribute("role", "region")
  expect(await front.evaluate((node) => !!node.closest("#main-content"))).toBe(
    true
  )
  await expect(front).toHaveCSS("position", "relative")
  await expect(page.locator('[data-slot="dialog-overlay"]')).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Close settings", exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Toggle Sidebar", exact: true })
  ).toHaveCount(1)
  await expect(composer).toBeHidden()
  await page.keyboard.press("Escape")
  await expect(front).toBeVisible()
  const sidebar = page.getByRole("button", {
    name: "Account menu for Bench",
    exact: true,
  })
  await sidebar.focus()
  await expect(sidebar).toBeFocused()
  const navigation = front.getByRole("navigation", {
    name: "Settings sections",
  })
  const originalNavigation = (await navigation.elementHandle())!
  const preferencesLink = navigation.getByRole("link", { name: "Preferences" })
  await preferencesLink.press("Enter")
  await expect(
    settingsFront(page).getByRole("heading", {
      name: "Preferences",
      exact: true,
    })
  ).toBeVisible()
  expect(await originalNavigation.evaluate((node) => node.isConnected)).toBe(
    true
  )
  await expect(preferencesLink).toBeFocused()
  await expect(front.locator(".settings-route-drawer:visible")).toHaveCSS(
    "transition-duration",
    "0s"
  )
  await page.screenshot({
    path: "test-results/settings-pages-desktop.png",
    animations: "disabled",
  })
  const preferences = settingsFront(page)
  const appearance = preferences.getByRole("heading", { name: "Appearance" })
  const theme = preferences.getByRole("group", { name: "Appearance" })
  for (const width of [768, 800]) {
    await page.setViewportSize({ width, height: 900 })
    const labelBounds = (await appearance.boundingBox())!
    const themeBounds = (await theme.boundingBox())!
    expect(labelBounds.width).toBeGreaterThan(80)
    expect(themeBounds.y).toBeGreaterThan(labelBounds.y + labelBounds.height)
    expect(themeBounds.x + themeBounds.width).toBeLessThan(width)
    await expect(
      preferences.getByRole("combobox", { name: "During a reply" })
    ).toBeVisible()
  }
  await page.setViewportSize({ width: 1280, height: 900 })
  await closeSettings(page)
  await expect(composer).toBeVisible()
  await expect(composer).toHaveValue("Keep this conversation draft")
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  await expect
    .poll(
      async () => (await page.locator(".chat-workspace").boundingBox())?.height
    )
    .toBe(chatHeight)
})

test("settings rows stack when the sidebars narrow the desktop pane", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop settings pane")
  await page.route(
    (url) =>
      [
        "/api/auth/list-sessions",
        "/api/auth/passkey/list-user-passkeys",
      ].includes(url.pathname),
    (route) => route.fulfill({ json: [] })
  )
  await signIn(page)
  for (const width of [768, 800]) {
    await page.setViewportSize({ width, height: 900 })
    for (const [path, copy, action] of [
      [
        "/settings/security",
        "#two-factor-heading",
        'section[aria-labelledby="two-factor-heading"] > button',
      ],
      [
        "/agents/navi/settings/general",
        ".settings-agent-summary h3",
        ".settings-agent-summary button",
      ],
      [
        "/agents/navi/settings/access",
        'input[aria-label="Filter tools"]',
        ".settings-workbench-actions",
      ],
    ] as const) {
      await page.goto(path)
      const pane = settingsFront(page)
      const label = pane.locator(copy)
      await expect(label).toBeVisible()
      const labelBounds = (await label.boundingBox())!
      const actionBounds = (await pane.locator(action).boundingBox())!
      expect(labelBounds.width).toBeGreaterThan(190)
      expect(actionBounds.y).toBeGreaterThan(labelBounds.y + labelBounds.height)
      expect(actionBounds.x + actionBounds.width).toBeLessThan(width)
    }
  }
})
