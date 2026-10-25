import { expect, test } from "@playwright/test"

const family = {
  id: "family",
  name: "Fixture family",
  role: "owner",
  ownerName: "Fixture admin",
  members: [
    {
      id: "owner-member",
      userId: "fixture-owner",
      name: "Fixture admin",
      email: "browser-smoke@example.invalid",
      role: "owner",
    },
  ],
  invitations: [],
}

test("an older family read cannot restore owner controls after a newer access denial", async ({
  page,
}) => {
  let checking = false,
    reads = 0
  let release!: () => void, newer!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const replacement = new Promise<void>((resolve) => {
    newer = resolve
  })
  await page.route("**/api/family", async (route) => {
    if (!checking) return route.fulfill({ json: family })
    reads++
    if (reads === 1) {
      await held
      return route.fulfill({ json: family })
    }
    newer()
    return route.fulfill({
      status: 403,
      json: { error: "Family access ended" },
    })
  })
  try {
    await page.goto("/agents")
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-smoke@example.invalid")
    await page
      .getByLabel("Password", { exact: true })
      .fill("Disposable browser fixture password 2026!")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await expect(
      page.getByRole("region", { name: "Your agents" })
    ).toBeVisible()
    checking = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect.poll(() => reads).toBe(1)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    // A serialized owner may queue the replacement until the old read joins.
    // The old implementation starts it immediately; hold the old reply behind it.
    await Promise.race([
      replacement,
      new Promise((resolve) => setTimeout(resolve, 250)),
    ])
    await page.waitForTimeout(50)
    release()
    await expect(
      page.getByRole("heading", {
        name: "Your family access has ended",
        exact: true,
      })
    ).toBeVisible()
    await expect(page.getByRole("region", { name: "Your agents" })).toHaveCount(
      0
    )
  } finally {
    release()
  }
})

const preview = {
  email: "invited@example.invalid",
  familyName: "Fixture family",
  inviterName: "Fixture admin",
  status: "pending",
}
const signedIn = {
  user: {
    id: "invited-user",
    email: preview.email,
    name: "Invited",
    emailVerified: true,
  },
  session: {
    id: "join-session",
    userId: "invited-user",
    token: "synthetic-session",
    expiresAt: "2030-01-01T00:00:00Z",
  },
}

test("invitation identity survives the actual auth SDK challenge redirect", async ({
  page,
}) => {
  let account: typeof signedIn | null = null
  let signins = 0,
    verifies = 0
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: account })
  )
  await page.route("**/api/family/invitation", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      invitation: "retained-invitation",
    })
    return route.fulfill({ json: preview })
  })
  await page.route("**/api/family/verify", (route) => {
    verifies++
    return route.fulfill({ json: {} })
  })
  await page.route("**/api/auth/sign-in/email", (route) => {
    signins++
    return route.fulfill({ json: { twoFactorRedirect: true } })
  })
  await page.goto("/join#invitation=retained-invitation")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page
    .getByLabel("Password", { exact: true })
    .fill("Synthetic password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/two-factor\?returnTo=%2Fjoin$/)
  const stored = await page.evaluate(() =>
    sessionStorage.getItem("pi:family-invitation:v1")
  )
  expect(stored).toBe('{"version":1,"invitation":"retained-invitation"}')
  account = signedIn
  await page.goto("/join")
  await expect(
    page.getByRole("button", { name: "Join family", exact: true })
  ).toBeVisible()
  await expect(page).toHaveURL(/#invitation=retained-invitation$/)
  expect(signins).toBe(1)
  expect(verifies).toBe(0)
})

test("a late invitation acceptance cannot clear a newer invitation URL", async ({
  page,
}) => {
  const reads: string[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let accepted = 0
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: signedIn })
  )
  await page.route("**/api/family/invitation", (route) => {
    reads.push(route.request().postDataJSON().invitation)
    return route.fulfill({ json: preview })
  })
  await page.route(
    "**/api/auth/organization/accept-invitation",
    async (route) => {
      accepted++
      await held
      await route.fulfill({
        json: { invitation: { id: "old" }, member: { id: "old-member" } },
      })
    }
  )
  try {
    await page.goto("/join#invitation=old")
    await page.getByRole("button", { name: "Join family", exact: true }).click()
    await expect.poll(() => accepted).toBe(1)
    await page.goto("/join#invitation=new")
    await expect(
      page.getByRole("heading", {
        name: "Opening your invitation",
        exact: true,
      })
    ).toBeVisible()
    expect(reads).toEqual(["old"])
    release()
    await expect.poll(() => reads).toEqual(["old", "new"])
    await expect(
      page.getByRole("button", { name: "Join family", exact: true })
    ).toBeVisible()
    await expect(page).toHaveURL(/#invitation=new$/)
    await expect(
      page.getByRole("heading", { name: "Your space is ready" })
    ).toHaveCount(0)
    expect(accepted).toBe(1)
  } finally {
    release()
  }
})

test("model exchange completion is fenced after family role revocation", async ({
  page,
}) => {
  let member = false,
    exchanges = 0
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/family", (route) =>
    route.fulfill({ json: { ...family, role: member ? "member" : "owner" } })
  )
  await page.route("**/api/agent/model-account?*", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: {
          pending: {
            id: "held",
            email: "owner@example.invalid",
            expiresAt: Date.now() + 60_000,
            authorizationUrl: "https://example.invalid/signin",
          },
        },
      })
    exchanges++
    await held
    await route.fulfill({
      json: { status: "connected", email: "owner@example.invalid" },
    })
  })
  try {
    await page.goto("/agents")
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-smoke@example.invalid")
    await page
      .getByLabel("Password", { exact: true })
      .fill("Disposable browser fixture password 2026!")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await expect(
      page.getByRole("region", { name: "Your agents" })
    ).toBeVisible()
    await page.goto("/family/model-access")
    await page
      .getByLabel("Return address", { exact: true })
      .fill("http://127.0.0.1:5000/auth/callback?code=synthetic")
    await page
      .getByRole("button", { name: "Finish connection", exact: true })
      .click()
    await expect.poll(() => exchanges).toBe(1)
    member = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(
      page.getByLabel("Return address", { exact: true })
    ).toHaveCount(0)
    release()
    await expect(
      page.getByRole("status").filter({ hasText: "ChatGPT connected as" })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Refresh connection", exact: true })
    ).toHaveCount(0)
    expect(exchanges).toBe(1)
  } finally {
    release()
  }
})
