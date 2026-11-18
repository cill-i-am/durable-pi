import { expect, test } from "@playwright/test"

import type { AccessState } from "../../src/access/contracts"
import { chatMessages } from "../../src/conversations/adapters/tanstack"

test("an archived conversation opens the directory that can restore it", async ({
  page,
}) => {
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        agents: [
          ...body.agents,
          {
            ...body.agents[0],
            id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            slug: "archived-helper",
            name: "Archived helper",
            status: "archived",
          },
        ],
      },
    })
  })
  await page.goto("/agents/archived-helper")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("textbox", { name: "Message Archived helper", exact: true })
  ).toHaveCount(0)
  await expect(page).toHaveURL(/\/agents\/archived$/)
  await expect(
    page.getByRole("button", { name: "Restore Archived helper", exact: true })
  ).toBeVisible()
})

test("conversation tool results and approval preserve an unsent draft across review", async ({
  page,
  isMobile,
}) => {
  const turn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  let access: AccessState = {
    tools: [
      {
        name: "read_calendar",
        title: "Read family calendar",
        description: "Read saved family dates.",
        mode: "allow",
        revision: 1,
      },
      {
        name: "write_note",
        title: "Save trip notes",
        description: "Save the agreed trip plan.",
        mode: "ask",
        revision: 2,
      },
    ],
    approvals: [
      {
        id: "trip-note-approval",
        turnId: turn,
        tool: "write_note",
        input: JSON.stringify({
          path: "family/holiday.md",
          body: "Friday to Monday",
        }),
        createdAt: Date.now(),
        expiresAt: Date.now() + 600000,
        status: "pending",
        revision: 4,
      },
    ],
  }
  const decisions: unknown[] = []
  let sends = 0
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "MESSAGES_SNAPSHOT",
          messages: chatMessages([
            {
              id: turn,
              text: "Find a weekend for our family trip and save the dates.",
              answer:
                "Friday to Monday works. I’ll save the plan once you approve it.",
              status: "running",
              error: null,
              created_at: "2026-11-18T10:00:00Z",
              activity: [
                {
                  id: "calendar-result",
                  type: "tool",
                  name: "read_calendar",
                  input: "{}",
                  output: "Friday to Monday is free.",
                  status: "done",
                },
              ],
            },
          ]),
        },
        {
          type: "CUSTOM",
          name: "durable-pi.metadata",
          value: {
            model: "test",
            connected: true,
            memory: { messages: 2, summaries: 0, ready: true, notes: [] },
            access,
          },
        },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  )
  await page.route("**/api/agent/access/decide**", (route) => {
    decisions.push(route.request().postDataJSON())
    access = {
      ...access,
      approvals: access.approvals.map((approval) => ({
        ...approval,
        status: "approved",
        revision: 5,
      })),
    }
    return route.fulfill({ json: access })
  })
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      sends++
  })
  await page.goto("/agents/navi")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const draft = page.getByRole("textbox", { name: "Message Navi", exact: true })
  await draft.fill("Keep this unsent draft")
  const dock = page.getByRole("region", {
    name: "Decisions awaiting approval",
    exact: true,
  })
  await expect(dock).toContainText("Save trip notes")
  await page.getByRole("button", { name: /1 step/ }).click()
  await expect(
    page.getByText("Read family calendar", { exact: true })
  ).toBeVisible()
  for (const width of isMobile ? [390, 320] : [1280, 800, 768]) {
    await page.setViewportSize({ width, height: 900 })
    const decision = (await dock.boundingBox())!
    const composer = (await page.locator(".chat-composer").boundingBox())!
    expect(decision.y + decision.height).toBeLessThanOrEqual(composer.y)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth
      )
    ).toBeLessThanOrEqual(1)
  }
  await page.getByRole("button", { name: "Review action", exact: true }).click()
  const review = page.getByRole("dialog", {
    name: "Save trip notes",
    exact: true,
  })
  await expect(review.locator("pre")).toContainText("family/holiday.md")
  await expect(review).toContainText("with any inputs")
  await page.screenshot({
    path: test.info().outputPath("conversation-approval.png"),
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(review).toBeHidden()
  await expect(
    page.getByRole("region", {
      name: "Approval for Save trip notes",
      exact: true,
    })
  ).toContainText("Approval accepted · waiting to run")
  await expect(draft).toHaveValue("Keep this unsent draft")
  expect(decisions).toEqual([
    { id: "trip-note-approval", approve: true, expectedRevision: 4 },
  ])
  expect(sends).toBe(0)
})

test("private participants have keyboard names and return focus to the chat", async ({
  page,
  isMobile,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
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
  const people = page.getByRole("button", {
    name: "People in this chat",
    exact: true,
  })
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Toggle Sidebar", exact: true })
    .focus()
  await page.keyboard.press("Tab")
  await expect(people).toBeFocused()
  await expect(people.locator(".conversation-person-avatar").first()).toHaveCSS(
    "inset-inline-start",
    "24px"
  )
  await expect(page.getByRole("tooltip")).toContainText("Bench, Navi")
  await page.keyboard.press("Enter")
  const sheet = page.getByRole("dialog", { name: "People in this chat" })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText("Bench", { exact: true })).toBeVisible()
  await expect(sheet.getByText("You", { exact: true })).toBeVisible()
  await expect(sheet.getByText("Navi", { exact: true })).toBeVisible()
  await expect(sheet.getByText("Assistant", { exact: true })).toBeVisible()
  await expect(sheet.getByRole("button", { name: /invite/i })).toHaveCount(0)
  await expect(sheet.getByRole("listitem")).toHaveCount(2)
  if (isMobile) {
    await expect(sheet).toHaveAttribute("data-overlay-mobile", "true")
    const heading = (await sheet
      .getByRole("heading", { name: "People in this chat" })
      .boundingBox())!
    const close = (await sheet
      .getByRole("button", { name: "Close", exact: true })
      .boundingBox())!
    const participant = (await sheet
      .getByRole("listitem")
      .first()
      .boundingBox())!
    expect(close.width).toBeGreaterThanOrEqual(44)
    expect(close.height).toBeGreaterThanOrEqual(44)
    expect(close.y).toBeLessThan(heading.y + heading.height)
    expect(close.y + close.height).toBeLessThanOrEqual(participant.y)
    await sheet.getByRole("button", { name: "Close", exact: true }).click()
  } else {
    await expect(sheet).not.toHaveAttribute("aria-modal", "true")
    const anchor = await people.boundingBox()
    const popup = await sheet.boundingBox()
    expect(popup?.width).toBe(320)
    expect(popup!.y).toBeGreaterThanOrEqual(anchor!.y + anchor!.height)
    expect(popup!.y - anchor!.y - anchor!.height).toBeLessThanOrEqual(12)
    await page.keyboard.press("Escape")
  }
  await expect(sheet).not.toBeVisible()
  await expect(people).toBeFocused()
  if (isMobile) {
    const composer = page.getByRole("textbox", {
      name: "Message Navi",
      exact: true,
    })
    await expect(composer).toHaveCSS("font-size", "16px")
    const target = await people.boundingBox()
    expect(target?.height).toBeGreaterThanOrEqual(44)
  }
})
