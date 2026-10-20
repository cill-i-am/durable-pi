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
  const picker = page.getByRole("combobox", { name: "Workbench tool" })
  await picker.click()
  for (const name of [
    "Browser",
    "Terminal",
    "Files",
    "Apps",
    "Activity",
    "Checklists",
    "Memory",
    "Code",
    "Routines",
  ]) {
    await expect(page.getByRole("option", { name, exact: true })).toBeVisible()
  }
  await page.getByRole("option", { name: "Activity", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi\/activity$/)
  await picker.click()
  await page.getByRole("option", { name: "Files", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi\/files$/)
  await page.reload()
  await expect(picker).toContainText("Files")
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
