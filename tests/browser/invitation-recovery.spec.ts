import { expect, test } from "@playwright/test"

const preview = {
  email: "invitation-recovery@example.invalid",
  familyName: "Fixture family",
  inviterName: "Fixture admin",
  status: "pending",
}

test("an invitation preview recovers from one temporary failure without reloading", async ({
  page,
}) => {
  let reads = 0
  let writes = 0
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null })
  )
  await page.route("**/api/family/verify", (route) => {
    writes++
    return route.fulfill({ json: { status: true } })
  })
  await page.route("**/api/family/invitation", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      invitation: "synthetic-invitation",
    })
    reads++
    return reads === 1
      ? route.fulfill({ status: 503, json: { error: "Temporary outage" } })
      : route.fulfill({ json: preview })
  })
  await page.goto("/join#invitation=synthetic-invitation")
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  expect(reads).toBe(2)
  expect(writes).toBe(0)
})

test("an unavailable preview can be retried in place without replaying email verification", async ({
  page,
}) => {
  let available = false
  let verifications = 0
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null })
  )
  await page.route("**/api/family/verify", (route) => {
    verifications++
    return route.fulfill({ json: { status: true } })
  })
  await page.route("**/api/family/invitation", (route) =>
    available
      ? route.fulfill({ json: preview })
      : route.fulfill({ status: 503, json: { error: "Temporary outage" } })
  )
  await page.goto(
    "/join#token=synthetic-verification&invitation=synthetic-invitation"
  )
  await expect(
    page.getByRole("heading", {
      name: "Couldn’t load your invitation",
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByRole("alert")).not.toContainText("expired")
  await expect(page).not.toHaveURL(/token=/)
  available = true
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  await expect(page).toHaveURL(/#invitation=synthetic-invitation$/)
  expect(verifications).toBe(1)
})

test("a cancelled invitation stays unavailable without retrying it", async ({
  page,
}) => {
  let reads = 0
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null })
  )
  await page.route("**/api/family/invitation", (route) => {
    reads++
    return route.fulfill({
      status: 404,
      json: { error: "No longer available" },
    })
  })
  await page.goto("/join#invitation=synthetic-cancelled")
  await expect(
    page.getByRole("heading", {
      name: "This invitation is unavailable",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Try again", exact: true })
  ).toHaveCount(0)
  expect(reads).toBe(1)
})

test("opening an email link in an existing join tab clears the previous error while it loads", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: null })
  )
  await page.route("**/api/auth/organization/list-user-invitations", (route) =>
    route.fulfill({ status: 401, json: { message: "Sign in required" } })
  )
  let release!: () => void
  const ready = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/family/invitation", async (route) => {
    await ready
    await route.fulfill({ json: preview })
  })
  await page.goto("/join")
  await expect(
    page.getByRole("heading", {
      name: "This invitation is unavailable",
      exact: true,
    })
  ).toBeVisible()
  await page.goto("/join#invitation=synthetic-invitation")
  await expect(
    page.getByRole("heading", { name: "Opening your invitation", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("alert")).toHaveCount(0)
  release()
  await expect(page.getByLabel("Your name", { exact: true })).toBeVisible()
})

test("a workspace load error retries the same page without a document reload", async ({
  page,
}) => {
  let reads = 0
  await page.route("**/api/fixture/route-ready", (route) => {
    reads++
    return route.fulfill({ status: reads === 1 ? 503 : 200, json: {} })
  })
  await page.goto("/__route-recovery")
  await expect(
    page.getByRole("heading", {
      name: "Couldn’t open this workspace.",
      exact: true,
    })
  ).toBeVisible()
  let navigations = 0
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Welcome back", exact: true })
  ).toBeVisible()
  await expect(page).toHaveURL(/\/__route-recovery$/)
  expect(reads).toBe(2)
  expect(navigations).toBe(0)
})
