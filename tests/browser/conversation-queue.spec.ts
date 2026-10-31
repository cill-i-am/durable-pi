import { expect, test } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"
import type { ChatState } from "../../src/conversations/contracts"

test("an idle reply starts immediately in the UI and only later messages are queued", async ({
  page,
}) => {
  const turn = (id: string, status: ChatState["turns"][number]["status"]) => ({
    id,
    status,
    text: `Question ${id}`,
    answer: status === "done" ? `Answer ${id}` : "",
    error: null,
    created_at: "2026-10-18T06:02:24Z",
  })
  let turns = [turn("first", "done"), turn("second", "queued")]
  await page.route("**/api/agent/events?**", async (route) => {
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: chatMessages(turns) },
      {
        type: "CUSTOM",
        name: "durable-pi.metadata",
        value: {
          model: "test",
          connected: true,
          memory: { messages: 2, summaries: 2, ready: true, notes: [] },
        },
      },
    ]
    await route.fulfill({
      contentType: "text/event-stream",
      body: frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
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
  const second = page
    .locator(".owner-message")
    .filter({ hasText: "Question second" })
  await expect(second).toContainText("Starting…")
  await expect(second).not.toContainText("Queued")
  await expect(second).toHaveAttribute("data-queued", "false")
  await expect(
    page
      .locator(".assistant-message")
      .getByRole("status")
      .filter({ hasText: "Starting…" })
  ).toBeVisible()
  turns = [...turns, turn("third", "queued")]
  await page.reload()
  const third = page
    .locator(".owner-message")
    .filter({ hasText: "Question third" })
  await expect(second).toContainText("Starting…")
  await expect(third).toContainText("Queued")
  await expect(third).toHaveAttribute("data-queued", "true")
  turns = [
    turn("first", "done"),
    turn("second", "done"),
    turn("third", "queued"),
  ]
  await page.reload()
  await expect(third).toContainText("Starting…")
  await expect(third).not.toContainText("Queued")
  await expect(third).toHaveAttribute("data-queued", "false")
})
