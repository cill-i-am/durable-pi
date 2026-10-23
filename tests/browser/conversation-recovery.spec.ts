import { expect, test, type Page } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"
import type { ChatState } from "../../src/conversations/contracts"

type Turn = ChatState["turns"][number]
const operationId = "00000000-0000-4000-8000-000000000071"
const savedAnswer = "Your saved reply remains available."
const turn = (overrides: Partial<Turn> = {}): Turn => ({
  id: operationId,
  revision: 7,
  status: "running",
  controlUnconfirmed: "observe",
  controlBusy: false,
  text: "Please check my saved dinner plan.",
  answer: savedAnswer,
  error: null,
  created_at: "2026-10-23T12:00:00Z",
  ...overrides,
})

/** Actual Conversation UI and production CSS; only its server responses are
 * synthetic. Snapshots advance explicitly, never on the stream's retry count. */
async function recoveryPage(page: Page, initial: Turn) {
  let current = initial,
    snapshots = 0,
    denied = false
  const posts: { path: string; agent: string | null; body: unknown }[] = []
  const replies: { url: string; release: (status: number) => void }[] = []
  await page.route("**/api/agent/**", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.fallback()
    const url = new URL(request.url())
    posts.push({
      path: url.pathname,
      agent: url.searchParams.get("agent"),
      body: request.postDataJSON() as unknown,
    })
    if (!url.pathname.startsWith("/api/agent/recovery/"))
      return route.fulfill({
        status: 409,
        json: { error: "Unexpected mutation in recovery test." },
      })
    const status = await new Promise<number>((release) => {
      replies.push({ url: request.url(), release })
    })
    await route.fulfill({ status, json: { ok: true } })
  })
  await page.route("**/api/agent/events?**", async (route) => {
    if (denied)
      return route.fulfill({ status: 403, json: { error: "Access denied." } })
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: chatMessages([current]) },
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
    await route.fulfill({
      contentType: "text/event-stream",
      body: frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
    snapshots++
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
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: /Navi/ })
    .click()
  const recovery = page.locator('[aria-label="Reply recovery"]')
  await expect(recovery).toBeVisible()
  return {
    posts,
    recovery,
    snapshots: () => snapshots,
    denyStream: () => {
      denied = true
    },
    publish: (next: Turn) => {
      current = next
    },
    respond: async (index: number, status = 200) => {
      const held = replies[index]!
      const received = page.waitForResponse(
        (response) =>
          response.url() === held.url && response.request().method() === "POST"
      )
      held.release(status)
      await received
    },
    releaseAll: () => {
      for (const held of replies) held.release(200)
    },
  }
}

const expectedPost = (action: "check" | "stop", revision: number) => ({
  path: `/api/agent/recovery/${action}`,
  agent: "home",
  body: { operationId, revision },
})

test("Check keeps the original identity, coalesces held clicks, and waits for a newer snapshot after acknowledgement", async ({
  page,
}) => {
  const f = await recoveryPage(page, turn())
  try {
    const check = f.recovery.getByRole("button", {
      name: "Check reply",
      exact: true,
    })
    await expect(check).toBeEnabled()
    await expect(
      f.recovery.getByRole("button", { name: "Try Stop again", exact: true })
    ).toHaveCount(0)
    await expect(
      page.getByRole("button", { name: "Retry message", exact: true })
    ).toHaveCount(0)
    await check.dblclick()
    await expect.poll(() => f.posts).toEqual([expectedPost("check", 7)])
    await expect(
      f.recovery.getByRole("button", { name: "Checking reply…", exact: true })
    ).toBeDisabled()
    await expect(page.getByText(savedAnswer, { exact: true })).toBeVisible()

    // Reloading the whole page would hide a component ownership regression.
    // The real acknowledgement refresh must retain the same-revision fence.
    const before = f.snapshots()
    await f.respond(0)
    await expect.poll(f.snapshots).toBeGreaterThan(before)
    await expect(check).toBeVisible()
    await expect(check).toBeDisabled()
    const replayed = f.snapshots()
    await expect.poll(f.snapshots).toBeGreaterThan(replayed)
    await expect(check).toBeDisabled()
    expect(f.posts).toEqual([expectedPost("check", 7)])

    f.publish(turn({ revision: 8 }))
    await expect(check).toBeEnabled()
    await check.click()
    await expect
      .poll(() => f.posts)
      .toEqual([expectedPost("check", 7), expectedPost("check", 8)])
    await f.respond(1)
    // Exact POST inventory also excludes /send, /retry and ordinary /cancel.
    expect(f.posts).toEqual([
      expectedPost("check", 7),
      expectedPost("check", 8),
    ])
  } finally {
    f.releaseAll()
  }
})

test("owned cleanup disables recovery and only explicit Try Stop again requests cancellation", async ({
  page,
}) => {
  const stopping = turn({
    revision: 12,
    status: "stopping",
    controlUnconfirmed: "stop",
    controlBusy: true,
  })
  const f = await recoveryPage(page, stopping)
  try {
    const check = f.recovery.getByRole("button", {
      name: "Check reply",
      exact: true,
    })
    const stop = f.recovery.getByRole("button", {
      name: "Try Stop again",
      exact: true,
    })
    await expect(f.recovery).toContainText("finish cleanup")
    await expect(check).toBeDisabled()
    await expect(stop).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Retry message", exact: true })
    ).toHaveCount(0)
    expect(f.posts).toEqual([])

    f.publish({ ...stopping, revision: 13, controlBusy: false })
    await expect(check).toBeEnabled()
    await expect(stop).toBeEnabled()
    expect(f.posts).toEqual([])
    await stop.dblclick()
    await expect.poll(() => f.posts).toEqual([expectedPost("stop", 13)])
    await expect(check).toBeDisabled()
    await expect(
      f.recovery.getByRole("button", { name: "Trying Stop…", exact: true })
    ).toBeDisabled()
    await f.respond(0, 202)
    await expect(stop).toBeVisible()
    await expect(f.recovery).toContainText("Stop could not be confirmed")
    await expect(
      page.getByRole("region", { name: "Messages" })
    ).not.toContainText("Stopped. Your message is saved.")
    expect(f.posts).toEqual([expectedPost("stop", 13)])

    f.publish({
      ...stopping,
      revision: 14,
      status: "cancelled",
      controlUnconfirmed: null,
      controlBusy: false,
    })
    await expect(f.recovery).toHaveCount(0)
    await expect(page.getByRole("region", { name: "Messages" })).toContainText(
      "Stopped. Your message is saved."
    )
    await expect(
      page.getByRole("button", { name: "Retry message", exact: true })
    ).toBeEnabled()
    await expect(page.getByText(savedAnswer, { exact: true })).toBeVisible()
    expect(f.posts).toEqual([expectedPost("stop", 13)])
  } finally {
    f.releaseAll()
  }
})

test("a known access denial after recovery refresh clears the saved reply and its controls", async ({
  page,
}) => {
  const f = await recoveryPage(page, turn())
  try {
    await f.recovery
      .getByRole("button", { name: "Check reply", exact: true })
      .click()
    await expect.poll(() => f.posts).toEqual([expectedPost("check", 7)])
    await expect(page.getByText(savedAnswer, { exact: true })).toBeVisible()

    f.denyStream()
    await f.respond(0)
    await expect(page.getByRole("alert")).toContainText(
      "This agent is not available."
    )
    await expect(page.getByText(savedAnswer, { exact: true })).toHaveCount(0)
    await expect(
      page.getByRole("region", { name: "Messages" })
    ).not.toContainText(turn().text)
    await expect(f.recovery).toHaveCount(0)
    expect(f.posts).toEqual([expectedPost("check", 7)])
  } finally {
    f.releaseAll()
  }
})
