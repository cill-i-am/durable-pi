import { expect, test } from "@playwright/test"
import { Schema } from "effect"

import {
  ConfigureEmail,
  RetryEmail,
  type EmailView,
} from "../../src/email/contracts"

test("enable and revoke an address; uncertain replies require an explicit resend", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let retries = 0
  let view: EmailView = {
    configured: true,
    enabled: false,
    revision: 0,
    address: null,
    messages: [
      {
        id: "fixture-email",
        subject: "Email fixture",
        state: "uncertain",
        error: "Delivery could not be confirmed.",
        createdAt: 1,
      },
    ],
  }
  await page.route("**/api/agent/email**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (path.endsWith("/configure")) {
      const input = Schema.decodeUnknownSync(ConfigureEmail)(
        request.postDataJSON()
      )
      view = {
        ...view,
        enabled: input.enabled,
        revision: view.revision + 1,
        address: input.enabled
          ? "pi+1234567812344234a234123456789abc.abcdefghijklmnopqrstuvwxyz@agents.example.com"
          : null,
      }
    }
    if (path.endsWith("/retry")) {
      const input = Schema.decodeUnknownSync(RetryEmail)(request.postDataJSON())
      expect(input.acknowledgeDuplicateRisk).toBe(true)
      retries++
      view = {
        ...view,
        messages: view.messages.map((message) => ({
          ...message,
          state: "sent",
          error: null,
        })),
      }
    }
    await route.fulfill({ json: view })
  })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await page.goto("/agents/home/settings/general")
  await page.getByRole("button", { name: "Enable email", exact: true }).click()
  await expect(page.getByLabel("Private email address")).toHaveValue(
    view.address!
  )
  await expect(
    page.getByText("Delivery unconfirmed", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Retry reply", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Send this reply again?" })
  ).toBeVisible()
  await page.screenshot({
    path: test.info().outputPath("email-resend-confirmation.png"),
    animations: "disabled",
  })
  expect(retries).toBe(0)
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(retries).toBe(0)
  await page.getByRole("button", { name: "Retry reply", exact: true }).click()
  await page.getByRole("button", { name: "Send again", exact: true }).click()
  await expect(page.getByText("Sent", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Send this reply again?" })
  ).toBeHidden()
  expect(retries).toBe(1)
  const width = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }))
  expect(width.content).toBeLessThanOrEqual(width.viewport)
  await page.screenshot({
    path: test.info().outputPath("email-settings.png"),
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Disable email", exact: true }).click()
  await expect(page.getByLabel("Private email address")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Enable email", exact: true })
  ).toBeEnabled()
  expect(errors).toEqual([])
})
