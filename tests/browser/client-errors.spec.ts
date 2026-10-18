import { expect, test } from "@playwright/test"
import { Schema } from "effect"

import { ClientErrorReport } from "../../src/observability/client-errors"

test("a real render exception records one private report with component and cause locations", async ({
  page,
}) => {
  const reports: ClientErrorReport[] = []
  await page.route("**/api/diagnostics/client-error", (route) => {
    const payload = route.request().postDataJSON()
    reports.push(Schema.decodeUnknownSync(ClientErrorReport)(payload))
    expect(JSON.stringify(payload)).not.toContain("PRIVATE_CHAT_CONTENT")
    return route.fulfill({ status: 204 })
  })
  await page.goto("/__client-error")
  await page
    .getByRole("button", {
      name: "Trigger synthetic render error",
      exact: true,
    })
    .click()
  await expect(page.getByText("Error reference:")).toBeVisible()
  expect(reports).toHaveLength(1)
  const report = reports[0]!
  expect(report.failure).toMatchObject({
    name: "TypeError",
    message: "Cannot read properties of undefined",
  })
  expect(report.failure.frames.length).toBeGreaterThan(0)
  expect(report.components.length).toBeGreaterThan(0)
  expect(report.causes[0]?.frames.length).toBeGreaterThan(0)
  await expect(page.getByText(report.id, { exact: true })).toBeVisible()
  let navigations = 0
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations++
  })
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(
    page.getByRole("button", {
      name: "Trigger synthetic render error",
      exact: true,
    })
  ).toBeVisible()
  expect(navigations).toBe(0)
  expect(reports).toHaveLength(1)
})
test("unavailable logging leaves error recovery usable without a false reference", async ({
  page,
}) => {
  await page.route("**/api/diagnostics/client-error", (route) =>
    route.fulfill({ status: 503 })
  )
  await page.goto("/__client-error")
  const logged = page.waitForResponse("**/api/diagnostics/client-error")
  await page
    .getByRole("button", {
      name: "Trigger synthetic render error",
      exact: true,
    })
    .click()
  await logged
  await expect(
    page.getByRole("heading", {
      name: "Couldn’t open this workspace.",
      exact: true,
    })
  ).toBeVisible()
  await expect(page.getByText("Error reference:")).toHaveCount(0)
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(
    page.getByRole("button", {
      name: "Trigger synthetic render error",
      exact: true,
    })
  ).toBeVisible()
})
