import { expect, test } from "@playwright/test"

const password = "Disposable auth fixture password 2026!"

test("owner setup keeps its request locked and returns to sign-in without retaining the setup key", async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const writes: unknown[] = []
  await page.route("**/api/setup", async (route) => {
    writes.push({
      token: route.request().headers()["x-setup-token"],
      body: route.request().postDataJSON(),
    })
    await held
    await route.fulfill({ json: { status: true } })
  })
  await page.goto("/agents")
  await page
    .getByRole("button", {
      name: "First time? Set up your account",
      exact: true,
    })
    .click()
  await expect(
    page.getByRole("heading", { name: "Create your account", exact: true })
  ).toBeVisible()
  await page.getByLabel("Your name", { exact: true }).fill("Fixture owner")
  await page
    .getByLabel("Setup key", { exact: true })
    .fill("synthetic-setup-key")
  await page.getByLabel("Password", { exact: true }).fill(password)
  await page
    .getByRole("button", { name: "Create owner account", exact: true })
    .click()
  await expect.poll(() => writes.length).toBe(1)
  await expect(page.getByLabel("Setup key", { exact: true })).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Back to sign in", exact: true })
  ).toBeDisabled()
  release()
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true })
  ).toBeVisible()
  await expect(page.getByLabel("Setup key", { exact: true })).toHaveCount(0)
  expect(writes).toEqual([
    { token: "synthetic-setup-key", body: { name: "Fixture owner", password } },
  ])
})

test("password recovery retries an unavailable request and shows the non-enumerating receipt", async ({
  page,
}) => {
  let writes = 0
  await page.route("**/api/auth/request-password-reset", (route) => {
    writes++
    expect(route.request().postDataJSON()).toEqual({
      email: "recovery@example.invalid",
    })
    return writes === 1
      ? route.fulfill({ status: 503, json: { message: "Synthetic failure" } })
      : route.fulfill({ json: { status: true } })
  })
  await page.goto("/forgot-password?returnTo=%2Fagents%2Fhome")
  await page
    .getByLabel("Email", { exact: true })
    .fill("recovery@example.invalid")
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText(
    "Could not request a reset"
  )
  await page
    .getByRole("button", { name: "Send reset link", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Check your inbox", exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("If this email belongs to your Pi account", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Back to sign in", exact: true })
  ).toHaveAttribute("href", "/agents/home")
  await page
    .getByRole("button", { name: "Try another email", exact: true })
    .click()
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("")
  expect(writes).toBe(2)
})

test("password reset validates confirmation, removes the token and provides recovery for missing links", async ({
  page,
}) => {
  let writes = 0
  await page.route("**/api/auth/reset-password", (route) => {
    writes++
    expect(route.request().postDataJSON()).toEqual({
      newPassword: password,
      token: "synthetic_reset_token_2026",
    })
    return route.fulfill({ json: { status: true } })
  })
  await page.goto("/reset-password#token=synthetic_reset_token_2026")
  await page.getByLabel("New password", { exact: true }).fill(password)
  await page
    .getByLabel("Confirm password", { exact: true })
    .fill("Different fixture password 2026!")
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText("match")
  expect(writes).toBe(0)
  await page.getByLabel("Confirm password", { exact: true }).fill(password)
  await page
    .getByRole("button", { name: "Reset password", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Your password is reset", exact: true })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/reset-password$/)
  expect(writes).toBe(1)
  await page.goto("/reset-password")
  await expect(
    page.getByRole("heading", {
      name: "This link isn’t available",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Request a new link", exact: true })
  ).toHaveAttribute("href", "/forgot-password")
})

test("two-factor recovery clears mode drafts and returns to the authenticator after a rejected code", async ({
  page,
}) => {
  let writes = 0
  await page.route("**/api/auth/two-factor/verify-backup-code", (route) => {
    writes++
    expect(route.request().postDataJSON()).toEqual({
      code: "synthetic-recovery-code",
      trustDevice: false,
    })
    return route.fulfill({
      status: 400,
      json: { code: "INVALID_BACKUP_CODE", message: "Invalid recovery code" },
    })
  })
  await page.goto("/two-factor?returnTo=%2Fagents")
  await page.getByLabel("Authentication code", { exact: true }).fill("123456")
  await page
    .getByRole("button", { name: "Use a recovery code", exact: true })
    .click()
  await expect(page.getByLabel("Recovery code", { exact: true })).toHaveValue(
    ""
  )
  await page
    .getByLabel("Recovery code", { exact: true })
    .fill("synthetic-recovery-code")
  await page
    .getByRole("button", { name: "Use code and sign in", exact: true })
    .click()
  await expect(page.getByRole("alert")).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Use code and sign in", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Use your authenticator", exact: true })
    .click()
  await expect(
    page.getByLabel("Authentication code", { exact: true })
  ).toHaveValue("")
  expect(writes).toBe(1)
})

test("unsupported passkeys leave password sign-in available", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "PublicKeyCredential", { value: undefined })
  })
  await page.goto("/agents")
  await expect(
    page.getByRole("button", { name: "Sign in with a passkey", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByText(
      "Passkeys aren’t supported here. Use your password to sign in.",
      { exact: true }
    )
  ).toBeVisible()
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Assistants", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Edit Navi", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Edit assistant", exact: true })
  ).toBeVisible()
  await expect(page.locator(".assistant-collection")).toBeAttached()
  await expect(page.locator(".chat-workspace")).toHaveCount(0)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page).toHaveURL(/\/agents$/)
})
