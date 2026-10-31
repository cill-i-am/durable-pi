import { expect, test } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"
import type { ChatState } from "../../src/conversations/contracts"

test("new replies stay in view when the recent history window rolls forward", async ({
  page,
}) => {
  const turn = (id: string): ChatState["turns"][number] => ({
    id,
    status: "done",
    text: `Question ${id}`,
    answer: `Answer ${id}`,
    error: null,
    created_at: "2026-10-21T19:00:00Z",
  })
  let turns = Array.from({ length: 100 }, (_, i) => turn(`history-${i}`))
  await page.route("**/api/agent/events?**", async (route) => {
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: chatMessages(turns) },
      {
        type: "CUSTOM",
        name: "durable-pi.metadata",
        value: {
          model: "test",
          connected: true,
          memory: { messages: 100, summaries: 0, ready: true, notes: [] },
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
  await page.route("**/api/agent/send?**", async (route) => {
    const input = route.request().postDataJSON()
    turns = [
      ...turns.slice(1),
      { ...turn(input.operationId), text: input.text },
    ]
    await route.fulfill({ json: { accepted: true } })
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
  await expect(
    page.getByText("Answer history-99", { exact: true })
  ).toBeInViewport()
  for (const text of ["Latest question one", "Latest question two"]) {
    await page
      .getByRole("textbox", { name: "Message Navi", exact: true })
      .fill(text)
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click()
    await expect.poll(() => turns.at(-1)?.text).toBe(text)
    const latest = turns.at(-1)!
    await expect(
      page.getByText(latest.answer, { exact: true })
    ).toBeInViewport()
    await expect(
      page.locator(".owner-message").filter({ hasText: text })
    ).toBeInViewport()
  }
})
