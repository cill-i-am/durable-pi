import { expect, test } from "@playwright/test"

test("sign in, open an agent, receive a fixture reply and reload it", async ({
  page,
  context,
  baseURL,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== baseURL) {
      errors.push(`Unexpected external request: ${route.request().url()}`)
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.goto("/agents")
  await expect(
    page.getByRole("heading", { name: "Welcome back." })
  ).toBeVisible()
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Incorrect fixture password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(
    "Email or password is incorrect"
  )
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const collection = page.getByRole("region", { name: "Your agents" })
  await expect(collection).toBeVisible()
  await collection.getByRole("link", { name: /Navi/ }).click()
  await expect(page).toHaveURL(/\/agents\/home/)
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await composer.fill("Please send the deterministic browser fixture reply.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(
    page.getByText("Fixture reply received.", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByText("Fixture reply received.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
  expect(errors).toEqual([])
})
