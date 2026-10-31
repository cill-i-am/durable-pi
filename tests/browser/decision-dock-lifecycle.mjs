import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { chromium, expect } from "@playwright/test"
import tailwind from "@tailwindcss/vite"
import { createServer } from "vite"

const root = fileURLToPath(new URL("../..", import.meta.url))
const fixture = root + "/tests/browser/fixtures/decision-dock"
const server = await createServer({
  configFile: false,
  root: fixture,
  resolve: { alias: { "@": root + "/src" } },
  plugins: [tailwind()],
  server: {
    host: "127.0.0.1",
    port: process.argv.includes("--serve-only") ? 4409 : 0,
    fs: { allow: [root] },
  },
  esbuild: { jsx: "automatic" },
})
await server.listen()
const url = `http://127.0.0.1:${server.httpServer.address().port}`
if (process.argv.includes("--serve-only")) {
  console.log(url)
  await new Promise(() => {})
}
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
page.setDefaultTimeout(5000)
const output = root + "/test-results/decision-dock"
await mkdir(output, { recursive: true })
const open = async () => {
  await page.goto(url)
  await page
    .getByRole("button", { name: "Review action", exact: true })
    .waitFor()
}
const review = async () => {
  await page.getByRole("button", { name: "Review action", exact: true }).click()
  await page.getByRole("dialog").waitFor()
}
const calls = () => page.evaluate(() => window.fixture.calls)
try {
  await open()
  await page.screenshot({ path: output + "/desktop.png" })
  await review()
  await page.keyboard.press("Tab")
  assert.equal(
    await page
      .getByRole("dialog")
      .evaluate((dialog) => dialog.contains(document.activeElement)),
    true
  )
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Review action", exact: true })
  ).toBeFocused()
  await review()
  await expect(
    page
      .getByRole("dialog")
      .getByText("Complete action inputs", { exact: true })
  ).toBeVisible()
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "workingDirectory"
  )
  await expect(page.getByRole("dialog")).toContainText("with any inputs")
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("region", { name: "Approval for Run Linux command" })
  ).toContainText("Approval accepted · waiting to run")
  assert.equal((await calls()).length, 1)
  assert.equal((await calls())[0].expectedRevision, 4)
  await expect(
    page.getByRole("button", { name: "2 awaiting approval" })
  ).toBeVisible()
  console.log(
    "allow acknowledgement advances queue without execution-complete claim"
  )

  await open()
  await review()
  await page.getByRole("button", { name: "Deny", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Approval for Run Linux command" })
  ).toContainText("Declined")
  assert.equal((await calls())[0].approve, false)
  console.log("deny records receipt once")

  await open()
  await review()
  await page.getByRole("button", { name: "Always allow", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "2 awaiting approval" })
  ).toBeVisible()
  assert.deepEqual((await calls())[0].remember, { expectedPolicyRevision: 2 })
  console.log(
    "future permission sends current policy revision and explicit scope"
  )

  await open()
  await page.getByRole("button", { name: "Later", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Write a note", exact: true })
  ).toBeVisible()
  assert.equal((await calls()).length, 0)
  await page.getByRole("button", { name: "3 awaiting approval" }).click()
  await page
    .getByRole("button", { name: "Run Linux command", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Run Linux command", exact: true })
  ).toBeVisible()
  assert.equal((await calls()).length, 0)
  console.log("Later defers locally and selecting queue does not submit")

  await review()
  await page.evaluate(() =>
    window.fixture.replace({
      input: '{"command":"replacement scope"}',
      revision: 5,
    })
  )
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await review()
  await expect(page.getByRole("dialog").locator("pre")).toContainText(
    "replacement scope"
  )
  assert.equal((await calls()).length, 0)
  console.log("revised generation closes old review before re-approval")

  await open()
  await page.evaluate(() => (window.fixture.mode = "uncertain"))
  await review()
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Check status", exact: true })
  ).toBeVisible()
  assert.equal((await calls()).length, 1)
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Check status", exact: true })
    .click()
  await expect.poll(() => page.evaluate(() => window.fixture.refreshes)).toBe(1)
  assert.equal((await calls()).length, 1)
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Deny", exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Close sheet", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "3 awaiting approval" }).click()
  await expect(
    page.getByRole("button", { name: "Write a note", exact: true })
  ).toBeDisabled()
  await page.evaluate(() => (window.fixture.refreshStatus = "approved"))
  await page.getByRole("button", { name: "Check status", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "2 awaiting approval" })
  ).toBeVisible()
  assert.equal((await calls()).length, 1)
  console.log(
    "uncertainty locks progression; check only refreshes and terminal receipt reconciles"
  )

  await open()
  await page.evaluate(() => (window.fixture.mode = "held"))
  await review()
  await page.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Saving decision…", exact: true }).last()
  ).toBeDisabled()
  await page.evaluate(() => window.fixture.unmount())
  await expect(page.getByText("Closed", { exact: true })).toBeVisible()
  await expect.poll(() => page.evaluate(() => window.fixture.aborted)).toBe(1)
  assert.equal((await calls()).length, 1)
  console.log(
    "unmount interrupts hosted request and joins cleanup without replay"
  )

  await page.setViewportSize({ width: 390, height: 844 })
  await open()
  await page.screenshot({ path: output + "/mobile.png" })
  await review()
  await expect
    .poll(async () => {
      const box = await page.getByRole("dialog").boundingBox()
      return box.y > 0 && box.y + box.height <= 845
    })
    .toBe(true)
  await page.screenshot({ path: output + "/mobile-detail.png" })
  await page.getByRole("button", { name: "Close sheet", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.getByRole("button", { name: "3 awaiting approval" }).click()
  await expect(page.getByRole("dialog")).toContainText("3 awaiting approval")
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: "Write a note", exact: true })
  ).toBeVisible()
  await page.screenshot({
    path: output + "/mobile-queue.png",
    animations: "disabled",
  })
  await page.getByRole("button", { name: "Close sheet", exact: true }).click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await page.setViewportSize({ width: 320, height: 700 })
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)
    )
    .toBe(true)
  await page.screenshot({ path: output + "/320.png" })
  await page.evaluate(() => window.fixture.setDisabled(true))
  await expect(
    page.getByRole("button", { name: "Review action", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Later", exact: true })
  ).toBeDisabled()
  assert.deepEqual(errors, [])
  console.log(
    "desktop/390/320 reflow, bottom sheet and disabled controls verified"
  )
} finally {
  await browser.close()
  await server.close()
}
