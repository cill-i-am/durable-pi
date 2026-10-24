import { expect, test, type Page, type Route } from "@playwright/test"

import type { BrowserState } from "../../src/browser/contracts"

const screenshot = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4X8AAAAASUVORK5CYII=",
  "base64"
)
function ready(generation = 4): BrowserState {
  return {
    controller: "owner",
    policy: { generation, hosts: ["example.com"] },
    version: 7,
    status: "ready",
    expiresAt: 9999999999999,
    hasScreenshot: true,
    error: null,
    page: {
      url: "https://example.com/",
      title: "Fixture page",
      text: "Fixture browser",
      links: [],
      capturedAt: 1,
    },
  }
}
async function openBrowser(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await page.goto("/agents/navi/browser")
}

test("browser controls require the loaded preview and never replay an uncertain action", async ({
  page,
}) => {
  let current = ready()
  let image: Route | undefined
  let reads = 0
  const actions: unknown[] = []
  await page.route("**/api/agent/browser**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/screenshot")) {
      image = route
      return
    }
    if (route.request().method() === "POST") {
      actions.push(route.request().postDataJSON())
      current = {
        ...current,
        status: "error",
        error: "The browser action outcome is uncertain.",
      }
      await route.abort("failed")
      return
    }
    reads++
    await route.fulfill({ json: current })
  })
  await openBrowser(page)
  const tab = page.getByRole("button", { name: "Tab field", exact: true })
  await expect(tab).toBeDisabled()
  await expect.poll(() => !!image).toBe(true)
  await image!.fulfill({ contentType: "image/png", body: screenshot })
  await expect(tab).toBeEnabled()
  await tab.click()
  await expect(tab).toBeDisabled()
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(page.getByRole("alert")).toContainText(
    "The browser action outcome is uncertain."
  )
  const prior = reads
  await expect.poll(() => reads, { timeout: 8000 }).toBeGreaterThan(prior)
  expect(actions).toEqual([
    { generation: 4, version: 7, action: { kind: "key", key: "Tab" } },
  ])
})

test("Close interrupts a pending browser request using newly observed generation", async ({
  page,
}) => {
  let current = ready()
  let open: Route | undefined
  const closes: unknown[] = []
  await page.route("**/api/agent/browser**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/screenshot")) {
      await route.fulfill({ contentType: "image/png", body: screenshot })
      return
    }
    if (route.request().method() === "POST") {
      if (path.endsWith("/open")) {
        open = route
        current = ready(9)
        return
      }
      expect(path).toBe("/api/agent/browser/close")
      closes.push(route.request().postDataJSON())
      current = {
        ...current,
        status: "closed",
        expiresAt: null,
        page: null,
        hasScreenshot: false,
      }
    }
    await route.fulfill({ json: current })
  })
  await openBrowser(page)
  await page
    .getByLabel("Browser URL", { exact: true })
    .fill("https://example.com/next")
  await page.getByRole("button", { name: "Go", exact: true }).click()
  await expect.poll(() => !!open).toBe(true)
  const close = page.getByRole("button", { name: "Close session", exact: true })
  await expect(close).toBeEnabled()
  await close.click()
  await expect(page.getByText("closed", { exact: true })).toBeVisible()
  await open!.fulfill({ json: ready(4) }).catch(() => {})
  await expect(page.getByText("closed", { exact: true })).toBeVisible()
  await expect(close).toHaveCount(0)
  expect(closes).toEqual([{ generation: 9 }])
})
