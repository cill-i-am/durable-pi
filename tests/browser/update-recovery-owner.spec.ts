import { expect, test } from "@playwright/test"

test("offline update recovery retains the draft and only navigates after an explicit online reload", async ({
  page,
  context,
}) => {
  let deployed = false,
    sends = 0,
    navigations = 0
  await page.route("**/api/version", (route) =>
    route.fulfill({ json: { revision: (deployed ? "b" : "a").repeat(40) } })
  )
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
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
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await composer.fill("Retain this offline unsent draft.")
  deployed = true
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  const reload = page.getByRole("button", { name: "Reload", exact: true })
  await expect(reload).toBeEnabled()
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  await context.setOffline(true)
  await expect(reload).toBeDisabled()
  await expect(
    page.getByText("Reconnect to the internet before reloading.", {
      exact: true,
    })
  ).toBeVisible()
  await expect(composer).toHaveValue("Retain this offline unsent draft.")
  expect(sends).toBe(0)
  expect(navigations).toBe(0)
  await context.setOffline(false)
  await expect(reload).toBeEnabled()
  expect(navigations).toBe(0)
  await reload.click()
  await expect.poll(() => navigations).toBe(1)
  await expect(composer).toHaveValue("Retain this offline unsent draft.")
  expect(sends).toBe(0)
})
