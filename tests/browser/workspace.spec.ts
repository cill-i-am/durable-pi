import { expect, test } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"
import type { ChatState } from "../../src/conversations/contracts"
import type { FileInfo } from "../../src/workspace/files"

test("sign in, open an agent, receive a fixture reply and reload it", async ({
  page,
  context,
  baseURL,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== baseURL) {
      errors.push(`Unexpected external request: ${route.request().url()}`)
      await route.abort()
      return
    }
    await route.continue()
  })
  await page.goto("/agents")
  await expect(
    page.getByRole("heading", { name: "Welcome back" })
  ).toBeVisible()
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Incorrect fixture password")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(
    "Email or password is incorrect"
  )
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const collection = page.getByRole("region", { name: "Assistants" })
  await expect(collection).toBeVisible()
  await collection.getByRole("link", { name: /Navi/ }).click()
  await expect(page).toHaveURL(/\/agents\/navi/)
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await expect(composer).toBeEnabled()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: "fixture-photo.png",
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
      "base64"
    ),
  })
  await expect(
    page.getByRole("button", {
      name: "Remove fixture-photo.png from message",
      exact: true,
    })
  ).toBeVisible()
  await composer.fill("Please send the deterministic browser fixture reply.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(
    page.getByText("Fixture reply received.", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("Human message", { exact: true })).toHaveCount(0)
  await expect(page.locator(".owner-message")).toContainText("Bench")
  await expect(
    page
      .locator(".assistant-message")
      .getByRole("link", { name: "Download fixture-photo.png", exact: true })
  ).toBeVisible()
  await expect(page.locator(".assistant-message img")).toHaveJSProperty(
    "naturalWidth",
    1
  )
  await page.reload()
  await expect(
    page.getByText("Fixture reply received.", { exact: true })
  ).toBeVisible()
  await expect(
    page
      .locator(".assistant-message")
      .getByRole("link", { name: "Download fixture-photo.png", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
  expect(errors).toEqual([])
})

test("send a PDF while extraction is pending and keep its durable preparing state after reload", async ({
  page,
}) => {
  const file: FileInfo = {
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "pending.pdf",
    mime: "application/pdf",
    kind: "document",
    size: 100,
    createdAt: "2026-10-19T07:00:00Z",
    status: "ready",
    trashed: false,
    extraction: {
      status: "pending",
      pages: 0,
      readPages: 0,
      characters: 0,
      truncated: false,
      error: null,
    },
  }
  let uploaded = false
  let turns: ChatState["turns"] = []
  await page.route("**/api/agent/files**", async (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith("/upload")) {
      uploaded = true
      await route.fulfill({ json: file })
    } else await route.fulfill({ json: { files: uploaded ? [file] : [] } })
  })
  await page.route("**/api/agent/events?**", async (route) => {
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: chatMessages(turns) },
      {
        type: "CUSTOM",
        name: "durable-pi.metadata",
        value: {
          model: "test",
          connected: true,
          memory: { messages: 0, summaries: 0, ready: true, notes: [] },
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
    expect(input.files).toEqual([file.id])
    turns = [
      {
        id: input.operationId,
        text: input.text,
        status: "queued",
        preparingFiles: true,
        answer: "",
        error: null,
        created_at: file.createdAt,
        attachments: [file],
      },
    ]
    await route.fulfill({
      json: {
        accepted: true,
        operationId: input.operationId,
        replyId: input.operationId,
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
    .getByRole("link", { name: /Navi/ })
    .click()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: file.name,
    mimeType: file.mime,
    buffer: Buffer.from("%PDF-synthetic"),
  })
  await expect(
    page.getByRole("button", {
      name: "Remove pending.pdf from message",
      exact: true,
    })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message Navi", exact: true })
    .fill("Read the PDF when ready")
  await expect(
    page.getByRole("button", { name: "Send message", exact: true })
  ).toBeEnabled()
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect.poll(() => turns.length).toBe(1)
  await page.reload()
  await expect(page.locator(".owner-message")).toContainText("Preparing files…")
  await expect(
    page
      .locator(".owner-message")
      .getByRole("button", { name: "Cancel", exact: true })
  ).toBeVisible()
})
