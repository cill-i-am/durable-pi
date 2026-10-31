import { expect, test } from "@playwright/test"

import { closeSettings, settingsFront } from "./settings-helpers"

test("desktop settings are non-modal pages inside the shell and retain the chat draft", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Mobile retains the stacked drawer flow")
  await page.goto("/agents/navi")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
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
  await front.getByRole("link", { name: "Preferences", exact: true }).click()
  await expect(
    settingsFront(page).getByRole("heading", {
      name: "Preferences",
      exact: true,
    })
  ).toBeVisible()
  await page.screenshot({
    path: "test-results/settings-pages-desktop.png",
    animations: "disabled",
  })
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
