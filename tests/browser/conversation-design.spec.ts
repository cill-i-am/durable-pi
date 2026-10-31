import { expect, test } from "@playwright/test"

test("private participants have keyboard names and return focus to the chat", async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page
    .getByRole("region", { name: "Assistants" })
    .getByRole("link", { name: /Navi/ })
    .click()
  const people = page.getByRole("button", {
    name: "People in this chat",
    exact: true,
  })
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .focus()
  await page.keyboard.press("Tab")
  await expect(people).toBeFocused()
  await expect(people.locator(".conversation-person-avatar").first()).toHaveCSS(
    "inset-inline-start",
    "24px"
  )
  await expect(page.getByRole("tooltip")).toContainText("Bench, Navi")
  await page.keyboard.press("Enter")
  const sheet = page.getByRole("dialog", { name: "People in this chat" })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("Bench", { exact: true })).toBeVisible()
  await expect(sheet.getByText("You", { exact: true })).toBeVisible()
  await expect(sheet.getByText("Navi", { exact: true })).toBeVisible()
  await expect(sheet.getByText("Assistant", { exact: true })).toBeVisible()
  await expect(sheet.getByRole("button", { name: /invite/i })).toHaveCount(0)
  await page.getByRole("button", { name: "Close dialog", exact: true }).click()
  await expect(sheet).not.toBeVisible()
  await expect(people).toBeFocused()
  if (isMobile) {
    const composer = page.getByRole("textbox", {
      name: "Message Navi",
      exact: true,
    })
    await expect(composer).toHaveCSS("font-size", "16px")
    const target = await people.boundingBox()
    expect(target?.height).toBeGreaterThanOrEqual(44)
  }
})
