import { expect, test } from "@playwright/test"

test("ID links become canonical slug URLs and preserve the selected view", async ({
  page,
}) => {
  await page.goto("/agents/home/settings/general")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi\/settings\/general$/)
  await page.goto("/agents/home/files?tab=trash")
  await expect(page).toHaveURL(/\/agents\/navi\/files\?tab=trash$/)
  await page.goto("/agents/navi/settings/general")
  await expect(
    page.getByText("Email this agent", { exact: true })
  ).toBeVisible()
  await page.goto("/agents")
  const link = page
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: "Navi", exact: true })
  await expect(link).toHaveAttribute("href", "/agents/navi")
  await link.click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
})
