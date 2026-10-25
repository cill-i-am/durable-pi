import { expect, test, type Page } from "@playwright/test"

const current = "a".repeat(40),
  next = "b".repeat(40)
const photo = {
  name: "draft-photo.png",
  mimeType: "image/png",
  buffer: Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
    "base64"
  ),
}
async function openChat(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: /Navi/ })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
}
async function updates(page: Page) {
  let deployed = false
  await page.route("**/api/version", (route) =>
    route.fulfill({ json: { revision: deployed ? next : current } })
  )
  return async () => {
    deployed = true
    await page.evaluate(() => window.dispatchEvent(new Event("focus")))
    await expect(
      page.getByText("A new version of Pi is available", { exact: true })
    ).toBeVisible()
  }
}
const composer = (page: Page) =>
  page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
    includeHidden: true,
  })

test("an explicit update reload preserves unsent text and original file references without sending", async ({
  page,
}) => {
  const offerUpdate = await updates(page)
  let sends = 0,
    navigations = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
  await openChat(page)
  await page.getByLabel("Choose files", { exact: true }).setInputFiles(photo)
  await expect(
    page.getByRole("button", {
      name: "Remove draft-photo.png from message",
      exact: true,
    })
  ).toBeVisible()
  await composer(page).fill("Keep this unsent draft after the update.")
  await offerUpdate()
  expect(sends).toBe(0)
  await page
    .getByRole("button", { name: "Send message", exact: true })
    .click({ trial: true })
  await page.screenshot({ path: test.info().outputPath("update-notice.png") })
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(composer(page)).toHaveValue(
    "Keep this unsent draft after the update."
  )
  await expect(
    page.getByRole("button", {
      name: "Remove draft-photo.png from message",
      exact: true,
    })
  ).toBeVisible()
  expect(sends).toBe(0)
  await expect.poll(() => navigations).toBe(1)
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: test.info().outputPath("update-draft-restored.png"),
  })
})

test("a retired settings chunk keeps chat intact and offers full reload instead of repeating navigation", async ({
  page,
}) => {
  const offerUpdate = await updates(page)
  await openChat(page)
  await composer(page).fill("Retain the draft while settings cannot load.")
  let retired = true,
    failures = 0
  await page.route(/\/assets\/workspace-settings-[^/]+\.js$/, async (route) => {
    if (retired) {
      failures++
      await route.fulfill({
        status: 404,
        contentType: "text/javascript",
        body: "",
      })
    } else await route.continue()
  })
  await offerUpdate()
  await page
    .getByRole("button", { name: "Agent settings and tools", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Tool access", exact: true }).click()
  await expect(
    page.getByText("Pi has been updated", { exact: true })
  ).toBeVisible()
  expect(failures).toBeGreaterThan(0)
  await expect(composer(page)).toHaveValue(
    "Retain the draft while settings cannot load."
  )
  await expect(
    page.getByRole("button", { name: "Try again", exact: true })
  ).toHaveCount(0)
  await page.screenshot({
    path: test.info().outputPath("retired-chunk-recovery.png"),
  })
  retired = false
  await page.getByRole("button", { name: "Reload page", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi\/settings\/access$/)
  await expect(
    page.getByRole("heading", { name: "Tool access", exact: true })
  ).toBeVisible()
  await expect(composer(page)).toHaveValue(
    "Retain the draft while settings cannot load."
  )
})

test("an unconfirmed send restores its original identity and never submits on reload", async ({
  page,
}) => {
  const offerUpdate = await updates(page)
  const submissions: { operationId: string }[] = []
  await page.route("**/api/agent/send?**", async (route) => {
    submissions.push(route.request().postDataJSON())
    if (submissions.length === 1) {
      await route.fetch()
      await route.fulfill({
        status: 503,
        json: { error: "Synthetic acknowledgement lost." },
      })
    } else await route.fulfill({ json: { accepted: true } })
  })
  await openChat(page)
  await composer(page).fill("Recover this original submission once.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(
    page.getByText("Synthetic acknowledgement lost.", { exact: true })
  ).toBeVisible()
  await offerUpdate()
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(composer(page)).toHaveValue(
    "Recover this original submission once."
  )
  expect(submissions).toHaveLength(1)
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(composer(page)).toHaveValue("")
  expect(submissions).toHaveLength(2)
  expect(submissions[1]?.operationId).toBe(submissions[0]?.operationId)
  await page.reload()
  await expect(composer(page)).toHaveValue("")
  await expect(
    page
      .locator(".owner-message")
      .filter({ hasText: "Recover this original submission once." })
  ).toHaveCount(1)
})

test("the update waits for a file upload to settle", async ({ page }) => {
  const offerUpdate = await updates(page)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route("**/api/agent/files/upload?**", async (route) => {
    await gate
    await route.continue()
  })
  try {
    await openChat(page)
    await page.getByLabel("Choose files", { exact: true }).setInputFiles(photo)
    await offerUpdate()
    await expect(
      page.getByRole("button", { name: "Reload", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByText(
        "Finish, retry or dismiss the file upload before reloading.",
        { exact: true }
      )
    ).toBeVisible()
    release()
    await expect(
      page.getByRole("button", {
        name: "Remove draft-photo.png from message",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Reload", exact: true })
    ).toBeEnabled()
  } finally {
    release()
  }
})

test("failed tab storage blocks reload until the draft can be preserved", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const write = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (
        key.startsWith("pi:composer:") &&
        value.includes("Cannot persist this draft")
      )
        throw new DOMException("Synthetic storage quota", "QuotaExceededError")
      return write.call(this, key, value)
    }
  })
  const offerUpdate = await updates(page)
  await openChat(page)
  await composer(page).fill("Cannot persist this draft")
  await offerUpdate()
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByText(
      "Your draft could not be saved in this tab. Copy it before reloading.",
      { exact: true }
    )
  ).toBeVisible()
  await composer(page).fill("This draft is saved successfully")
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(composer(page)).toHaveValue("This draft is saved successfully")
})
