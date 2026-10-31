import { mkdir } from "node:fs/promises"

import { expect, test, type Page } from "@playwright/test"

import { closeSettings } from "./settings-helpers"

const owner = {
  id: "family-owner",
  userId: "fixture-owner",
  name: "Cillian",
  email: "cillian@example.invalid",
  role: "owner",
}
const member = {
  id: "family-claire",
  userId: "fixture-claire",
  name: "Claire",
  email: "claire@example.invalid",
  role: "member",
}
const family = {
  id: "family",
  name: "Barron family",
  role: "owner",
  ownerName: "Cillian",
  members: [owner, member],
  invitations: [] as {
    id: string
    email: string
    expiresAt: string
    status: string
    delivery: string
  }[],
}
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
async function assertFits(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
}

test("admin can invite and remove with safe focus and retained private data copy", async ({
  page,
}) => {
  const data = structuredClone(family)
  await page.route("**/api/family", (route) => route.fulfill({ json: data }))
  await page.route("**/api/auth/organization/invite-member", async (route) => {
    const body = route.request().postDataJSON()
    expect(body.organizationId).toBe("family")
    expect(body.role).toBe("member")
    data.invitations = [
      {
        id: "invitation-fixture",
        email: body.email,
        expiresAt: "2026-10-24T00:00:00.000Z",
        status: "pending",
        delivery: "sent",
      },
    ]
    await route.fulfill({ json: data.invitations[0] })
  })
  await page.route("**/api/auth/organization/remove-member", async (route) => {
    expect(route.request().postDataJSON().memberIdOrEmail).toBe(member.id)
    data.members = [owner]
    await route.fulfill({ json: { member } })
  })
  await signIn(page)
  await page.goto("/family")
  await expect(
    page.getByRole("heading", { name: "Family", exact: true })
  ).toBeVisible()
  await expect(page.getByText("Your work stays yours")).toBeVisible()
  await assertFits(page)
  await page.getByRole("button", { name: "Invite someone" }).click()
  await page.getByLabel("Email address").fill("taylor@example.invalid")
  await page
    .getByRole("button", { name: "Send invitation", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Invitation sent" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect(
    page.getByText("taylor@example.invalid", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Manage Claire", exact: true }).click()
  await page.getByRole("menuitem", { name: "Remove from family" }).click()
  const dialog = page.getByRole("alertdialog")
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true })
  ).toBeFocused()
  await expect(dialog).toContainText("Their private work will be retained")
  await assertFits(page)
  await dialog.getByRole("button", { name: "Remove from family" }).click()
  await expect(dialog).not.toBeVisible()
  await expect(
    page.getByText("Claire was removed from the family.")
  ).toBeVisible()
})

test("member family screen is read only, and a shared model outage preserves an editable draft", async ({
  page,
}) => {
  await page.route("**/api/family", (route) =>
    route.fulfill({ json: { ...family, role: "member" } })
  )
  await signIn(page)
  await page.goto("/family?returnTo=%2Fagents%2Fnavi")
  await expect(
    page.getByRole("heading", { name: "Family", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Invite someone" })
  ).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Manage Claire" })).toHaveCount(
    0
  )
  await expect(
    page.getByText("Cillian manages family invitations", { exact: false })
  ).toBeVisible()
  await assertFits(page)
  await page.getByRole("button", { name: "Model access", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Model access", exact: true })
  ).toBeVisible()
  await expect(
    page
      .getByRole("region", { name: "Model access", exact: true })
      .getByText("Provided by Cillian.", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Refresh connection" })
  ).toHaveCount(0)
  await closeSettings(page)
  const draft = page.getByRole("textbox", { name: "Message Navi", exact: true })
  await draft.fill("Keep this private draft while ChatGPT reconnects.")
  await page.request.post("/api/fixture/model-connection", {
    data: { connected: false },
  })
  await expect(
    page
      .locator("#main-content")
      .getByText("Cillian needs to reconnect ChatGPT.", { exact: false })
  ).toBeVisible()
  await expect(draft).toHaveValue(
    "Keep this private draft while ChatGPT reconnects."
  )
  await draft.fill("Still editable.")
  await expect(draft).toHaveValue("Still editable.")
  await expect(
    page.getByRole("button", { name: "Send message", exact: true })
  ).toBeDisabled()
})

test("invitation creates an account, verifies email, then opens a private welcome", async ({
  page,
}) => {
  let account: {
    user: { id: string; email: string; name: string; emailVerified: boolean }
    session: { id: string; userId: string; token: string; expiresAt: string }
  } | null = null
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: account })
  )
  await page.route("**/api/family/invitation", (route) =>
    route.fulfill({
      json: {
        email: member.email,
        familyName: family.name,
        inviterName: owner.name,
        status: "pending",
      },
    })
  )
  await page.route("**/api/auth/sign-up/email", (route) => {
    expect(route.request().headers()["x-family-invitation"]).toBe(
      "synthetic-invitation"
    )
    account = {
      user: {
        id: member.userId,
        email: member.email,
        name: member.name,
        emailVerified: false,
      },
      session: {
        id: "session",
        userId: member.userId,
        token: "synthetic",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    }
    return route.fulfill({ json: { token: "synthetic", user: account.user } })
  })
  await page.route("**/api/family/verify", (route) => {
    expect(route.request().postDataJSON().token).toBe("synthetic-verification")
    if (account) account.user.emailVerified = true
    return route.fulfill({ json: { status: true } })
  })
  await page.route("**/api/auth/organization/accept-invitation", (route) =>
    route.fulfill({
      json: {
        member,
        invitation: { id: "synthetic-invitation", status: "accepted" },
      },
    })
  )
  await page.goto("/join#invitation=synthetic-invitation")
  await page.getByLabel("Your name", { exact: true }).fill(member.name)
  await page
    .getByLabel("Create a password", { exact: true })
    .fill("Disposable join fixture password 2026!")
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true })
  ).toBeVisible()
  await page.goto(
    "/join#token=synthetic-verification&invitation=synthetic-invitation"
  )
  await expect(
    page.getByRole("button", { name: "Join family", exact: true })
  ).toBeVisible()
  await expect(page).not.toHaveURL(/token=/)
  await page.getByRole("button", { name: "Join family", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Your workspace is ready", exact: true })
  ).toBeVisible()
  await assertFits(page)
})

test("expired verification can be resent without losing a valid family invitation", async ({
  page,
}) => {
  const account = {
    user: {
      id: member.userId,
      name: member.name,
      email: member.email,
      emailVerified: false,
    },
    session: {
      id: "session",
      userId: member.userId,
      token: "synthetic",
      expiresAt: "2030-01-01T00:00:00.000Z",
    },
  }
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({ json: account })
  )
  await page.route("**/api/family/invitation", (route) =>
    route.fulfill({
      json: {
        email: member.email,
        familyName: family.name,
        inviterName: owner.name,
        status: "pending",
      },
    })
  )
  await page.route("**/api/family/verify", (route) =>
    route.fulfill({ status: 400, json: { error: "Expired verification" } })
  )
  let sent = false
  await page.route("**/api/auth/send-verification-email", (route) => {
    expect(route.request().headers()["x-family-invitation"]).toBe(
      "synthetic-invitation"
    )
    expect(route.request().postDataJSON().email).toBe(member.email)
    sent = true
    return route.fulfill({ json: { status: true } })
  })
  await page.goto(
    "/join#token=expired-synthetic-token&invitation=synthetic-invitation"
  )
  await expect(
    page.getByRole("heading", { name: "Check your email", exact: true })
  ).toBeVisible()
  await expect(page.getByRole("alert")).toContainText(
    "verification link could not be confirmed"
  )
  await page
    .getByRole("button", { name: "Resend verification email", exact: true })
    .click()
  await expect(page.getByRole("status")).toContainText(
    "Verification email sent."
  )
  expect(sent).toBe(true)
  await expect(page).not.toHaveURL(/token=/)
})

test("admin reconnects ChatGPT in Settings with a private return-address field and recovery", async ({
  page,
  context,
}, info) => {
  const capture = ".impeccable/review/chatgpt-reconnect"
  await mkdir(capture, { recursive: true })
  const attempt = {
    id: "synthetic-attempt",
    email: owner.email,
    expiresAt: Date.now() + 600_000,
    authorizationUrl:
      "https://auth.openai.com/api/accounts/authorize?client_id=oaiapp_synthetic",
  }
  let pending: typeof attempt | null = null
  let completed = false
  let catalogUnavailable = false
  await page.route("**/api/agent/models?*", (route) =>
    route.fulfill(
      completed && catalogUnavailable
        ? {
            status: 503,
            json: { error: "Synthetic temporary catalog outage" },
          }
        : {
            json: {
              models: [],
              checkedAt: completed ? new Date().toISOString() : null,
              error: completed ? null : "Synthetic disconnected account",
              usage: "ChatGPT plan usage",
              selection: {
                model: "test",
                thinking: "medium",
                settingsRevision: 0,
              },
              assignments: {},
            },
          }
    )
  )
  await page.route("**/api/family", (route) => route.fulfill({ json: family }))
  await context.route("https://auth.openai.com/**", (route) =>
    route.fulfill({
      contentType: "text/plain",
      body: "Synthetic provider sign-in for browser regression test.",
    })
  )
  await page.route("**/api/agent/model-account?*", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { pending } })
    const input = route.request().postDataJSON()
    if (input.action === "start") {
      expect(input.email).toBe(owner.email)
      pending = attempt
      return route.fulfill({ json: pending })
    }
    expect(input.action).toBe("finish")
    expect(input.id).toBe(attempt.id)
    if (!input.address.includes("code=synthetic-code"))
      return route.fulfill({
        status: 400,
        json: {
          error:
            "Paste the full return address from the ChatGPT sign-in you just opened.",
        },
      })
    completed = true
    pending = null
    await page.request.post("/api/fixture/model-connection", {
      data: { connected: true },
    })
    return route.fulfill({ json: { status: "connected", email: owner.email } })
  })
  await signIn(page)
  await page.goto("/family/model-access")
  await expect(page.getByLabel("ChatGPT email", { exact: true })).toHaveValue(
    owner.email
  )
  const start = page.getByRole("button", {
    name: "Sign in with ChatGPT",
    exact: true,
  })
  await expect(start).toBeEnabled()
  await assertFits(page)
  await page.screenshot({
    path: `${capture}/build-${info.project.name}-start.png`,
    fullPage: true,
  })
  const popupEvent = context.waitForEvent("page")
  await start.click()
  const popup = await popupEvent
  await expect(popup).toHaveURL(attempt.authorizationUrl)
  await popup.close()
  const field = page.getByLabel("Return address", { exact: true })
  await expect(field).toBeFocused()
  await expect(
    page.getByText("the last page may say it can’t connect", { exact: false })
  ).toBeVisible()
  await assertFits(page)
  await page.screenshot({
    path: `${capture}/build-${info.project.name}-finish.png`,
    fullPage: true,
  })
  await page.reload()
  await expect(field).toBeVisible()
  await field.fill("http://127.0.0.1:53000/auth/callback?code=wrong")
  await page
    .getByRole("button", { name: "Finish connection", exact: true })
    .click()
  await expect(
    page.getByRole("alert").filter({ hasText: "Paste the full return address" })
  ).toBeVisible()
  await expect(field).toHaveValue("")
  await expect(field).toBeFocused()
  await page.screenshot({
    path: `${capture}/build-${info.project.name}-retry.png`,
    fullPage: true,
  })
  await field.fill(
    "http://127.0.0.1:53000/auth/callback?code=synthetic-code&state=synthetic-state"
  )
  catalogUnavailable = true
  await field.press("Enter")
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: `ChatGPT connected as ${owner.email}` })
  ).toBeVisible()
  expect(completed).toBe(true)
  await expect(
    page.getByText("Check unavailable", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("alert").filter({
      hasText: "Could not verify model availability. Refresh to retry.",
    })
  ).toBeVisible()
  await expect(
    page.getByText("Sign in above to restore access for the family.", {
      exact: false,
    })
  ).toHaveCount(0)
  await page.screenshot({
    path: `${capture}/build-${info.project.name}-catalog-unavailable.png`,
    fullPage: true,
  })
  catalogUnavailable = false
  await page
    .getByRole("button", { name: "Refresh connection", exact: true })
    .click()
  await expect(
    page
      .getByRole("region", { name: "Model access", exact: true })
      .getByText("Connected", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Back to chat", exact: true })
  ).toBeEnabled()
  await expect(field).toHaveCount(0)
  await assertFits(page)
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "synthetic-code"
  )
  await page.screenshot({
    path: `${capture}/build-${info.project.name}-restored.png`,
    fullPage: true,
  })
})

test("model access recovers automatically after a transient catalog polling failure", async ({
  page,
}) => {
  let unavailable = false
  let successfulReads = 0
  await page.route("**/api/agent/model-account?*", (route) =>
    route.fulfill({ json: { pending: null } })
  )
  await page.route("**/api/family", (route) => route.fulfill({ json: family }))
  await page.route("**/api/agent/models?*", (route) => {
    if (unavailable)
      return route.fulfill({ status: 503, json: { error: "Temporary outage" } })
    successfulReads++
    return route.fulfill({
      json: {
        models: [],
        checkedAt: new Date().toISOString(),
        error: null,
        usage: "ChatGPT plan usage",
        selection: { model: "test", thinking: "medium", settingsRevision: 0 },
        assignments: {},
      },
    })
  })
  await page.clock.install()
  await signIn(page)
  await page.goto("/family/model-access")
  const access = page.getByRole("region", { name: "Model access", exact: true })
  await expect(access.getByText("Connected", { exact: true })).toBeVisible()
  unavailable = true
  await page.clock.runFor(60_100)
  await expect(
    access.getByText("Needs attention", { exact: true })
  ).toBeVisible()
  const previous = successfulReads
  unavailable = false
  await page.clock.runFor(60_100)
  await expect.poll(() => successfulReads).toBeGreaterThan(previous)
  await expect(access.getByText("Connected", { exact: true })).toBeVisible()
  await expect(access.getByRole("alert")).toHaveCount(0)
})
