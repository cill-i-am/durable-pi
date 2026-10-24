import { expect, test, type Page } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"

const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Navi", exact: true })
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
  await expect(composer(page)).toBeEnabled()
}
async function storedDraft(page: Page) {
  return page.evaluate(() => {
    const key = Object.keys(sessionStorage).find((key) =>
      key.startsWith("pi:composer:")
    )
    return key ? { key, raw: sessionStorage.getItem(key)! } : null
  })
}

test("unreadable saved data survives restoration and blocks update reload without submitting", async ({
  page,
}) => {
  let deployed = false,
    sends = 0
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
  await openChat(page)
  await composer(page).fill("Preserve this future draft")
  await expect.poll(() => storedDraft(page)).not.toBeNull()
  const saved = (await storedDraft(page))!
  const raw = JSON.stringify({
    ...JSON.parse(saved.raw),
    version: 2,
    text: "Future format must survive",
  })
  await page.evaluate(({ key, raw }) => sessionStorage.setItem(key, raw), {
    key: saved.key,
    raw,
  })
  await page.reload()
  await expect(composer(page)).toBeVisible()
  deployed = true
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    page.getByText("A new version of Pi is available", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText(
      "Your saved draft could not be read. Keep this tab open; its original data has been retained.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Send message", exact: true })
  ).toBeDisabled()
  await composer(page).fill("New text retained in this tab")
  expect((await storedDraft(page))?.raw).toBe(raw)
  expect(sends).toBe(0)
})

test("failed persistence cannot dispatch a message", async ({ page }) => {
  let sends = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
  await openChat(page)
  await page.evaluate(() => {
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith("pi:composer:"))
        throw new Error("Synthetic storage denial")
      original.call(this, key, value)
    }
  })
  await composer(page).fill("Unsaved request must stay here")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(
    page.getByText(
      "Your draft could not be saved. Keep this tab open and try again.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(composer(page)).toHaveValue("Unsaved request must stay here")
  expect(sends).toBe(0)
})

test("a held acknowledgement clears only its own attempt and preserves newer text", async ({
  page,
}) => {
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const submissions: { operationId: string; text: string }[] = []
  await page.route("**/api/agent/send?**", async (route) => {
    submissions.push(route.request().postDataJSON())
    await held
    await route.fulfill({ status: 200, json: {} })
  })
  await openChat(page)
  await composer(page).fill("First submitted text")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect.poll(() => submissions.length).toBe(1)
  expect(JSON.parse((await storedDraft(page))!.raw).attempt.operationId).toBe(
    submissions[0]!.operationId
  )
  await composer(page).fill("Newer unsent text")
  await expect(
    page.getByRole("button", { name: "Send message", exact: true })
  ).toBeDisabled()
  release()
  await expect(
    page.getByRole("button", { name: "Send message", exact: true })
  ).toBeEnabled()
  await expect(composer(page)).toHaveValue("Newer unsent text")
  await expect
    .poll(async () => JSON.parse((await storedDraft(page))!.raw).attempt)
    .toBeNull()
  expect(submissions).toHaveLength(1)
})

test("Stop remains available after a retry starts while its HTTP acknowledgement is held", async ({
  page,
}) => {
  let active = false,
    release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancellations: { operationId: string }[] = []
  const retryId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
  await page.route("**/api/agent/events?**", (route) => {
    const turns = [
      {
        id: active ? retryId : "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        status: active ? ("running" as const) : ("failed" as const),
        text: "Retry then stop this reply",
        answer: "",
        error: active ? null : "Synthetic prior failure",
        created_at: "2026-10-18T06:02:24Z",
      },
    ]
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: chatMessages(turns) },
      {
        type: "CUSTOM",
        name: "durable-pi.metadata",
        value: {
          model: "test",
          connected: true,
          memory: { messages: 1, summaries: 0, ready: true, notes: [] },
        },
      },
    ]
    return route.fulfill({
      contentType: "text/event-stream",
      body: frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  })
  await page.route("**/api/agent/retry?**", async (route) => {
    active = true
    await held
    await route.fulfill({ status: 200, json: {} })
  })
  await page.route("**/api/agent/cancel?**", (route) => {
    cancellations.push(route.request().postDataJSON())
    return route.fulfill({ status: 200, json: {} })
  })
  await openChat(page)
  try {
    await page
      .getByRole("button", { name: "Retry message", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Stop response", exact: true })
      .click()
    await expect.poll(() => cancellations).toEqual([{ operationId: retryId }])
  } finally {
    release()
  }
})
