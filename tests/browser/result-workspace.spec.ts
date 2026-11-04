import { expect, test, type Page } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"
import { answerExamples } from "../../src/features/rich-results/examples"
import { resultReference } from "../../src/navigation/result-reference"

const turn = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const tool = "recorded-table"
const output = answerExamples.find((example) => example.id === "table")!.output
const title = "A week of household spending"
const identity = { turn, tool, element: "answer" }
const reference = resultReference(identity)
const activity = [
  {
    id: tool,
    type: "tool" as const,
    name: "show_ui",
    input: "{}",
    output,
    status: "done" as const,
  },
]

async function fixture(page: Page, history: () => boolean = () => true) {
  let submitted = 0
  let reads = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      submitted++
  })
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "MESSAGES_SNAPSHOT",
          messages: chatMessages(
            history()
              ? [
                  {
                    id: turn,
                    text: "Review my spending",
                    status: "done",
                    error: null,
                    answer: "Here are your expenses.",
                    created_at: "2026-10-31T12:00:00Z",
                    activity,
                  },
                ]
              : []
          ),
        },
        {
          type: "CUSTOM",
          name: "durable-pi.metadata",
          value: {
            model: "test",
            connected: true,
            memory: { messages: 2, summaries: 0, ready: true, notes: [] },
          },
        },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  )
  await page.route("**/api/agent/activity/conversations/**", (route) => {
    reads++
    return route.fulfill({
      json: {
        id: turn,
        source: "user",
        text: "Review my spending",
        answer: "Here are your expenses.",
        status: "done",
        error: null,
        activity,
      },
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
    .getByRole("link", { name: "Navi", exact: true })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
  return { submitted: () => submitted, reads: () => reads }
}

test("recorded result filters and unfinished filter input survive promotion, hiding, expansion, resize and closing", async ({
  page,
}, info) => {
  const evidence = await fixture(page)
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await composer.fill("Keep this unsent draft.")
  const inline = page
    .locator(".chat-workspace .rich-result")
    .filter({ has: page.getByText(title, { exact: true }) })
    .first()
  await inline
    .getByRole("textbox", { name: `Filter ${title}`, exact: true })
    .fill("Food")
  await inline
    .getByRole("button", { name: "Sort by Amount (EUR)", exact: true })
    .click()
  await inline.getByRole("button", { name: "Add filter", exact: true }).click()
  await page.getByLabel("Value", { exact: true }).fill("Groceries")
  await page.keyboard.press("Escape")
  await inline
    .getByRole("button", { name: "Open in workbench", exact: true })
    .click()
  const workspace = page.locator(".result-workbench").filter({ visible: true })
  await expect(page).toHaveURL(new RegExp(`/results/${reference}$`))
  await expect(
    workspace.getByRole("textbox", { name: `Filter ${title}`, exact: true })
  ).toHaveValue("Food")
  await expect(
    workspace.getByRole("columnheader", {
      name: "Sort by Amount (EUR)",
      exact: true,
    })
  ).toHaveAttribute("aria-sort", "descending")
  await workspace
    .getByRole("button", { name: "Add filter", exact: true })
    .click()
  await expect(page.getByLabel("Value", { exact: true })).toHaveValue(
    "Groceries"
  )
  await page.keyboard.press("Escape")
  if (info.project.name === "desktop") {
    await page
      .getByRole("button", { name: "Expand workbench", exact: true })
      .click()
    await expect(composer).not.toBeVisible()
    await page
      .getByRole("button", { name: "Collapse workbench", exact: true })
      .click()
    await page.setViewportSize({ width: 390, height: 844 })
    await expect(
      workspace.getByRole("textbox", { name: `Filter ${title}`, exact: true })
    ).toHaveValue("Food")
    await page.setViewportSize({ width: 1280, height: 900 })
  }
  await page
    .getByRole("button", { name: "Hide workbench", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
  await inline
    .getByRole("button", { name: "View in workbench", exact: true })
    .click()
  await expect(
    workspace.getByRole("textbox", { name: `Filter ${title}`, exact: true })
  ).toHaveValue("Food")
  await page
    .getByRole("button", { name: `Close ${title} tab`, exact: true })
    .click()
  await expect(
    inline.getByRole("textbox", { name: `Filter ${title}`, exact: true })
  ).toHaveValue("Food")
  await expect(composer).toHaveValue("Keep this unsent draft.")
  expect(evidence.submitted()).toBe(0)
  expect(evidence.reads()).toBe(0)
})

test("a result deep link reload reads only its recorded tool and unavailable identities retain a safe return", async ({
  page,
}) => {
  let history = true
  const evidence = await fixture(page, () => history)
  await page
    .getByRole("button", { name: "Open in workbench", exact: true })
    .click()
  await expect(page).toHaveURL(new RegExp(`/results/${reference}$`))
  history = false
  await page.reload()
  const workspace = page.locator(".result-workbench").filter({ visible: true })
  await expect(
    workspace.getByRole("textbox", { name: `Filter ${title}`, exact: true })
  ).toBeVisible()
  expect(evidence.reads()).toBeGreaterThan(0)
  const missing = resultReference({ ...identity, tool: "missing-tool" })
  await page.goto(`/agents/navi/results/${missing}`)
  await expect(workspace.getByRole("alert")).toBeVisible()
  await expect(workspace.getByRole("alert")).toContainText(
    "This saved result is unavailable."
  )
  await expect(
    page.getByRole("button", { name: "Try again", exact: true })
  ).toBeVisible()
  await workspace
    .getByRole("button", { name: "Back to conversation", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
  expect(evidence.submitted()).toBe(0)
})
