import { expect, type Page } from "@playwright/test"

export const settingsFront = (page: Page) =>
  page.locator('[data-settings-route][data-settings-frontmost="true"]')

export const settingsRoot = (page: Page) =>
  page.locator("[data-settings-route][data-settings-index]")

export const settingsFrame = (page: Page, path: string) =>
  page.locator(`[data-settings-route="${path}"]`)

export async function settingsIndex(page: Page) {
  for (let depth = 0; depth < 16; depth++) {
    const front = settingsFront(page)
    await expect(front).toBeVisible()
    const back = front.getByRole("button", { name: /^Back to / })
    if (!(await back.count())) return
    const previous = await front.getAttribute("data-settings-route")
    await back.click()
    await expect(settingsFront(page)).not.toHaveAttribute(
      "data-settings-route",
      previous!
    )
  }
  throw new Error("Settings did not return to its index.")
}

export async function closeSettings(page: Page) {
  await settingsIndex(page)
  await settingsFront(page)
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
}
