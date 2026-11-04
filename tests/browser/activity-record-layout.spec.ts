import { expect, test, type Page } from "@playwright/test"

const agent = { id: "home", name: "Personal assistant" }
const at = "2026-10-30T10:43:00.000Z"
const reference = "11111111-1111-4111-8111-111111111111"
const cursor = { at: "2026-10-29T09:00:00.000Z", key: "older" }
const entry = {
  key: reference,
  at,
  agent,
  kind: "conversation",
  title: "Recorded Lisbon request",
  status: "done",
  attention: true,
  running: false,
  target: "conversation",
  reference,
}
const saved = {
  source: "user",
  id: reference,
  text: "Original private request",
  answer: "Saved private reply",
  status: "done",
  error: null,
  activity: [],
}
async function signIn(
  page: Page,
  path = "/agents/home/activity?filter=attention"
) {
  await page.goto(path)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}
async function fixture(
  page: Page,
  read: "saved" | "unavailable" | "held" = "saved"
) {
  const writes: string[] = []
  const aborted: string[] = []
  let available = read === "saved",
    started = false
  page.on("requestfailed", (request) => {
    if (request.url().includes("/activity/conversations/"))
      aborted.push(request.url())
  })
  await page.route("**/api/agent/activity**", async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    if (request.method() !== "GET") {
      writes.push(request.method() + " " + url.pathname)
      return route.abort()
    }
    if (url.pathname.includes("/activity/conversations/")) {
      started = true
      if (read === "held") return
      return route.fulfill(
        available
          ? { json: saved }
          : {
              status: 503,
              json: {
                error:
                  "Recorded conversation unavailable. Reconnect to try again.",
              },
            }
      )
    }
    return route.fulfill({
      json: {
        entries: [entry],
        issues: [],
        unavailable: [],
        next: url.searchParams.has("cursor") ? null : cursor,
      },
    })
  })
  return {
    writes,
    aborted,
    started: () => started,
    reconnect: () => {
      available = true
    },
  }
}

test("record detail returns to the retained filtered page and restores the selected row", async ({
  page,
}, info) => {
  const f = await fixture(page)
  await signIn(page)
  await page
    .getByRole("button", { name: "Earlier activity", exact: true })
    .click()
  const originalUrl = page.url()
  const list = page.locator(".activity-timeline-list")
  await list.evaluate((node) =>
    node.setAttribute("data-retention-proof", "same-list")
  )
  const row = page.getByRole("button", { name: /Recorded Lisbon request/ })
  await row.click()
  const mobile = info.project.name === "mobile"
  const record = page.getByRole(mobile ? "dialog" : "region", {
    name: "Saved conversation",
    exact: true,
  })
  await expect(record).toBeVisible()
  await expect(record).toContainText("Original private request")
  await expect(record).toContainText("Saved private reply")
  await expect(record.locator(`time[datetime="${at}"]`)).toBeVisible()
  await expect(
    record.getByRole("button", { name: "Open assistant", exact: true })
  ).toBeVisible()
  if (mobile) {
    const action = record
      .locator('[data-slot="sheet-footer"]')
      .getByRole("button", { name: "Open assistant", exact: true })
    await expect(action).toBeInViewport()
    await page.setViewportSize({ width: 320, height: 430 })
    await expect(action).toBeInViewport()
    await page.setViewportSize({ width: 390, height: 844 })
  }
  await expect(
    record.getByRole("button", { name: /Stop|Approve|Request cancellation/ })
  ).toHaveCount(0)
  await record
    .getByRole("button", {
      name: mobile ? "Activity" : "Back to activity",
      exact: true,
    })
    .click()
  await expect(page).toHaveURL(originalUrl)
  await expect(list).toHaveAttribute("data-retention-proof", "same-list")
  await expect(
    page.getByRole("button", { name: "Needs you", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect(row).toBeVisible()
  if (!mobile) await expect(row).toBeFocused()
  expect(f.writes).toEqual([])
})

test("unavailable historical detail can reconnect without losing its return path", async ({
  page,
}, info) => {
  const f = await fixture(page, "unavailable")
  await signIn(page)
  await page.getByRole("button", { name: /Recorded Lisbon request/ }).click()
  const record = page.getByRole(
    info.project.name === "mobile" ? "dialog" : "region",
    { name: "Saved conversation", exact: true }
  )
  await expect(record).toContainText("Recorded conversation unavailable.")
  f.reconnect()
  await record.getByRole("button", { name: "Reconnect", exact: true }).click()
  await expect(record).toContainText("Saved private reply")
  await record
    .getByRole("button", {
      name: info.project.name === "mobile" ? "Activity" : "Back to activity",
      exact: true,
    })
    .click()
  await expect(
    page.getByRole("button", { name: /Recorded Lisbon request/ })
  ).toBeVisible()
  expect(f.writes).toEqual([])
})

test("hiding the retained Activity tab releases a held record observation without any business command", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The native child drawer owns the phone until it returns to Activity."
  )
  const f = await fixture(page, "held")
  await signIn(page)
  await page.getByRole("button", { name: /Recorded Lisbon request/ }).click()
  await expect.poll(f.started).toBe(true)
  await page.getByRole("button", { name: "Open a tool", exact: true }).click()
  await page.getByRole("menuitem", { name: "Files", exact: true }).click()
  await expect(
    page.getByRole("tab", { name: "Files", exact: true })
  ).toHaveAttribute("aria-selected", "true")
  await expect.poll(() => f.aborted.length).toBeGreaterThan(0)
  await expect(
    page.getByRole("tab", { name: "Activity", exact: true })
  ).toHaveCount(1)
  expect(f.writes).toEqual([])
})
