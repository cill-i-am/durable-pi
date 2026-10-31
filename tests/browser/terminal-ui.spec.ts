import { expect, test, type Page, type Route } from "@playwright/test"

import type { CommandRun, TerminalState } from "../../src/terminal/contracts"

const state = (): TerminalState => ({
  networkPolicy: { revision: 1, unrestricted: false },
  runs: [],
  savedAt: null,
  busy: false,
  cleanupError: null,
  session: null,
})
const run = (
  id: string,
  kind: "session" | "export" = "export"
): CommandRun => ({
  id,
  command: kind === "session" ? "Interactive terminal" : "Export file",
  kind,
  status: "succeeded",
  output: "",
  error: null,
  exitCode: 0,
  createdAt: 1,
  finishedAt: 2,
  savedAt: 2,
  ...(kind === "export"
    ? {
        transfer: {
          kind: "export",
          path: "/workspace/result.txt",
          name: "result.txt",
        },
      }
    : {}),
})
async function open(page: Page, route: string) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.goto(route)
}

test("uncertain terminal transfer retries its original ID and immutable path", async ({
  page,
}) => {
  const requests: { id: string; path: string }[] = []
  await page.route("**/api/agent/terminal**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/export")) {
      requests.push(route.request().postDataJSON())
      if (requests.length === 1) return route.abort("failed")
      return route.fulfill({ json: run(requests[0]!.id) })
    }
    return route.fulfill({
      json:
        path === "/api/agent/terminal"
          ? state()
          : run(requests[0]?.id ?? "export"),
    })
  })
  await open(page, "/agents/navi/terminal?tab=transfers")
  await page
    .getByLabel("File to export", { exact: true })
    .fill("/workspace/result.txt")
  await page
    .getByRole("button", { name: "Prepare export", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Retry transfer", exact: true })
  ).toBeEnabled()
  await expect(
    page.getByLabel("File to export", { exact: true })
  ).toBeDisabled()
  await page
    .getByRole("button", { name: "Retry transfer", exact: true })
    .click()
  await expect(
    page.getByRole("button", {
      name: "Add exported file to Files",
      exact: true,
    })
  ).toBeVisible()
  expect(requests).toHaveLength(2)
  expect(requests[1]).toEqual(requests[0])
})

test("closing a terminal tab during export download never begins a later Files upload", async ({
  page,
}) => {
  let download: Route | undefined,
    uploads = 0
  await page.route("**/api/agent/files/upload**", async (route) => {
    uploads++
    await route.abort()
  })
  await page.route("**/api/agent/terminal**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/file")) {
      download = route
      return
    }
    return route.fulfill({
      json: path === "/api/agent/terminal" ? state() : run("saved-export"),
    })
  })
  await open(page, "/agents/navi/terminal/saved-export?tab=transfers")
  await page
    .getByRole("button", { name: "Add exported file to Files", exact: true })
    .click()
  await expect.poll(() => !!download).toBe(true)
  await page
    .getByRole("button", { name: "Close Terminal tab", exact: true })
    .click()
  await expect(
    page.getByRole("region", { name: "Command output", exact: true })
  ).not.toBeVisible()
  await download!
    .fulfill({ contentType: "text/plain", body: "synthetic export" })
    .catch(() => {})
  await page.waitForTimeout(150)
  expect(uploads).toBe(0)
})

test("lease revocation disconnects the actual terminal socket and blocks save", async ({
  page,
}) => {
  let renew: Route | undefined,
    renewals = 0,
    closes = 0
  await page.routeWebSocket(
    "**/api/agent/terminal/session/**/socket**",
    (socket) => {
      socket.onClose(() => {
        closes++
      })
      socket.send('{"type":"ready"}')
    }
  )
  await page.route("**/api/agent/terminal**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/renew")) {
      renewals++
      renew = route
      return
    }
    return route.fulfill({
      json: {
        ...state(),
        busy: true,
        session: {
          id: "leased",
          phase: "ready",
          expiresAt: Date.now() + 30000,
          maximumAt: Date.now() + 60000,
        },
      },
    })
  })
  await open(page, "/agents/navi/terminal?tab=interactive")
  await expect(
    page.getByRole("status").filter({ hasText: /^Connected$/ })
  ).toBeVisible()
  await expect.poll(() => !!renew).toBe(true)
  await renew!.fulfill({ status: 401, json: { error: "Sign-in expired" } })
  await expect(
    page.getByText(
      "Sign-in expired. The terminal will stop without saving. Sign in again to continue.",
      { exact: true }
    )
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save and close", exact: true })
  ).toBeDisabled()
  await expect.poll(() => closes).toBe(1)
  expect(renewals).toBe(1)
})

test("unconfirmed session opening retries the same session ID", async ({
  page,
}) => {
  const requests: { id: string }[] = []
  await page.route("**/api/agent/terminal**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (path.endsWith("/session") && route.request().method() === "POST") {
      requests.push(route.request().postDataJSON())
      if (requests.length === 1) return route.abort("failed")
      return route.fulfill({ json: run(requests[0]!.id, "session") })
    }
    return route.fulfill({
      json:
        path === "/api/agent/terminal"
          ? state()
          : run(requests[0]?.id ?? "session", "session"),
    })
  })
  await open(page, "/agents/navi/terminal?tab=interactive")
  await page
    .getByRole("button", { name: "Open interactive terminal", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Retry opening same session", exact: true })
    .click()
  await expect.poll(() => requests.length).toBe(2)
  expect(requests[1]).toEqual(requests[0])
})
