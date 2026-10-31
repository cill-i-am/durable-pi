import { expect, test, type Page } from "@playwright/test"

import { closeSettings, settingsFront } from "./settings-helpers"

async function signIn(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
}

async function openSettings(page: Page, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click()
  await page
    .getByRole("button", { name: "Account menu for Bench", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(settingsFront(page)).toBeVisible()
}

test("settings after hiding a retained workbench keep it closed and return to the same draft", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  await page.goto("/agents/navi")
  if (!isMobile) {
    await page.addStyleTag({
      content: `
        @keyframes hold-workbench-close { from { opacity: 1; } to { opacity: 0; } }
        .workbench-sheet[data-ending-style] { animation: hold-workbench-close 30s linear; }
      `,
    })
  }
  const draft = page.getByRole("textbox", { name: "Message Navi", exact: true })
  await draft.fill("Keep this private conversation draft")
  await page
    .getByRole("button", { name: "Open workbench", exact: true })
    .click()
  if (isMobile)
    await expect(
      page.getByRole("button", { name: "Close Files tab", exact: true })
    ).toBeVisible()
  else
    await expect(
      page.getByRole("tab", { name: "Files", exact: true })
    ).toBeVisible()
  await page
    .getByRole("button", { name: "Hide workbench", exact: true })
    .click()
  if (!isMobile)
    await expect(
      page.locator(".workbench-sheet[data-ending-style]")
    ).toHaveCount(1)
  await expect(draft).toBeVisible()
  await openSettings(page, isMobile)
  await expect(page.locator('.workbench-host[data-open="true"]')).toHaveCount(0)
  if (!isMobile) {
    // Settings opens while native CLOSED is still withheld, not after it.
    await expect(
      page.locator(".workbench-sheet[data-ending-style]")
    ).toHaveCount(1)
    await page.evaluate(() =>
      document.getAnimations().forEach((animation) => {
        if (
          animation instanceof CSSAnimation &&
          animation.animationName === "hold-workbench-close"
        )
          animation.finish()
      })
    )
    await expect(page.locator(".workbench-sheet")).toBeHidden()
  }
  await closeSettings(page)
  await expect(draft).toHaveValue("Keep this private conversation draft")
  await expect(draft).toBeVisible()
  await expect(page.locator('.workbench-host[data-open="true"]')).toHaveCount(0)
})

test("device animation preference reaches shared controls and native overlay CSS", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  if (!isMobile) {
    await page
      .getByRole("button", { name: "Collapse sidebar", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Account menu for Bench", exact: true })
    ).toBeVisible()
  }
  await openSettings(page, isMobile)
  await settingsFront(page)
    .getByRole("link", { name: "Preferences", exact: true })
    .click()
  const control = page.getByRole("switch", {
    name: "Interface animations",
    exact: true,
  })
  await expect(control).toBeChecked()
  await control.click()
  await expect(control).not.toBeChecked()
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-motion",
    "reduced"
  )
  await expect
    .poll(() =>
      page
        .locator("[data-settings-frontmost=true]")
        .evaluate((node) =>
          Math.max(
            ...getComputedStyle(node)
              .transitionDuration.split(",")
              .map(Number.parseFloat)
          )
        )
    )
    .toBeLessThan(0.001)
  await control.click()
  await expect(page.locator("html")).toHaveAttribute("data-ui-motion", "full")
})
