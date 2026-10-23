import { expect, test, type Page } from "@playwright/test"

import type { AppDetail } from "../../src/apps/contracts"
import type { RoutineList } from "../../src/routines/contracts"

const routineId = "11111111-1111-4111-8111-111111111111"
const runId = "22222222-2222-4222-8222-222222222222"
const appId = "33333333-3333-4333-8333-333333333333"
const createdAt = "2026-10-23T12:00:00Z"
const scheduledAt = Date.parse(createdAt)

async function signIn(page: Page, path: string) {
  await page.goto(path)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}

function routineFixture(status: "stopping" | "unconfirmed"): RoutineList {
  return {
    routines: [
      {
        id: routineId,
        title: "Recovery review",
        prompt: "Review saved work after its existing run settles.",
        schedule: { type: "interval", at: scheduledAt, minutes: 60 },
        status: "active",
        revision: 2,
        nextAt: scheduledAt + 3_600_000,
        createdAt: scheduledAt,
        updatedAt: scheduledAt,
      },
    ],
    runs: [
      {
        id: runId,
        routineId,
        routineRevision: 2,
        title: "Existing recovery run",
        prompt: "Inspect this existing run before starting another.",
        turnId: "44444444-4444-4444-8444-444444444444",
        trigger: "scheduled",
        scheduledAt,
        createdAt: scheduledAt,
        status,
        deadline: scheduledAt + 600_000,
        finishedAt: null,
        error:
          status === "stopping"
            ? "Stop requested. Waiting for the existing run to finish cleanup."
            : "The existing run is unconfirmed. Inspect its conversation and retry Stop; do not start another run.",
      },
    ],
  }
}

for (const status of ["stopping", "unconfirmed"] as const) {
  test(`routine ${status} retains occupancy and stops only the selected existing run`, async ({
    page,
    context,
    baseURL,
  }) => {
    const errors: string[] = []
    const writes: { path: string; body: unknown }[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/api/agent/") && request.method() !== "GET")
        writes.push({ path, body: request.postDataJSON() })
    })
    await context.route("**/*", async (route) => {
      if (new URL(route.request().url()).origin !== baseURL) {
        errors.push(`Unexpected external request: ${route.request().url()}`)
        await route.abort()
      } else await route.continue()
    })
    const fixture = routineFixture(status)
    let release!: () => void
    const stopped = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route("**/api/agent/routines**", async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: fixture })
      } else if (new URL(route.request().url()).pathname.endsWith("/stop")) {
        await stopped
        await route.fulfill({ json: { stopped: true } })
      } else {
        await route.fulfill({
          status: 409,
          json: { error: "No new run is authorized by this fixture." },
        })
      }
    })
    await signIn(page, "/agents/navi/routines")
    const runs = page.getByRole("region", { name: "Recent routine runs" })
    const label = status === "stopping" ? "Stopping" : "Needs attention"
    await expect(runs.getByText(label, { exact: true })).toBeVisible()
    await expect(runs).toContainText(fixture.runs[0]!.error!)
    await expect(runs).toContainText("Budget ends")
    await expect(runs.getByText(/^(done|completed|cancelled)$/i)).toHaveCount(0)
    const runNow = page.getByRole("button", { name: "Run now", exact: true })
    const stop = runs.getByRole("button", { name: "Stop run", exact: true })
    await expect(runNow).toBeDisabled()
    await expect(stop).toBeEnabled()
    expect(writes).toEqual([])
    await stop.click()
    try {
      await expect
        .poll(() => writes)
        .toEqual([{ path: "/api/agent/routines/stop", body: { id: runId } }])
      await expect(stop).toBeDisabled()
      await expect(runNow).toBeDisabled()
      await expect(runs.getByText(label, { exact: true })).toBeVisible()
    } finally {
      release()
    }
    await expect(stop).toBeEnabled()
    await expect(runs.getByText(label, { exact: true })).toBeVisible()
    await page.reload()
    await expect(runs.getByText(label, { exact: true })).toBeVisible()
    await expect(runNow).toBeDisabled()
    await expect(stop).toBeEnabled()
    await expect(
      runs.getByRole("button", { name: /retry|replay|run again/i })
    ).toHaveCount(0)
    expect(writes).toEqual([
      { path: "/api/agent/routines/stop", body: { id: runId } },
    ])
    expect(errors).toEqual([])
  })
}

const appDefinition: AppDetail["app"]["definition"] = {
  title: "Retained recovery checklist",
  description: "Saved values remain available after delivery stops.",
  blocks: [
    {
      type: "checklist",
      id: "saved",
      title: "Saved work",
      items: [{ id: "review", label: "Saved review is checked" }],
    },
  ],
}

const appFixture: AppDetail = {
  app: {
    id: appId,
    version: 1,
    revision: 4,
    publishedVersion: 1,
    archived: false,
    createdAt,
    definition: appDefinition,
    state: { checks: { "saved/review": true }, forms: {} },
  },
  versions: [{ id: appId, version: 1, definition: appDefinition, createdAt }],
  events: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      appId,
      turnId: "66666666-6666-4666-8666-666666666666",
      version: 1,
      text: "Retained update cancelled after the bot was archived.",
      createdAt,
      delivery: "cancelled",
      deliveryMessage:
        "This bot was archived before conversation admission. Saved app state is retained.",
    },
    {
      id: "77777777-7777-4777-8777-777777777777",
      appId,
      turnId: "88888888-8888-4888-8888-888888888888",
      version: 1,
      text: "Retained update whose delivery budget was exhausted.",
      createdAt,
      delivery: "exhausted",
      deliveryMessage:
        "Conversation admission could not be confirmed within the bounded recovery budget. Saved app state and its interaction receipt are retained. Resolve the model or storage failure, then send a new interaction to notify the bot.",
    },
  ],
}

test("cancelled and exhausted app updates retain saved content without claiming delivery or replaying", async ({
  page,
  context,
  baseURL,
}) => {
  const errors: string[] = []
  const writes: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname
    if (path.startsWith("/api/agent/") && request.method() !== "GET")
      writes.push(path)
  })
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== baseURL) {
      errors.push(`Unexpected external request: ${route.request().url()}`)
      await route.abort()
    } else await route.continue()
  })
  await page.route("**/api/agent/apps**", async (route) => {
    if (route.request().method() !== "GET") {
      await route.fulfill({
        status: 409,
        json: { error: "No mutation is authorized by this fixture." },
      })
    } else {
      await route.fulfill({
        json:
          new URL(route.request().url()).pathname === "/api/agent/apps"
            ? { apps: [appFixture.app] }
            : appFixture,
      })
    }
  })
  await signIn(page, `/agents/navi/apps/${appId}`)
  const app = page.getByRole("region", { name: "Private app" })
  for (let pass = 0; pass < 2; pass++) {
    await expect(
      app.getByRole("checkbox", { name: "Saved review is checked" })
    ).toBeChecked()
    await app
      .locator("summary")
      .filter({ hasText: "Recent app updates (2)" })
      .click()
    for (const event of appFixture.events) {
      const row = app.getByRole("listitem").filter({ hasText: event.text })
      await expect(row).toContainText(
        event.delivery === "cancelled" ? "Cancelled" : "Delivery stopped"
      )
      await expect(row).toContainText(event.deliveryMessage!)
      await expect(row).toContainText(event.text)
      await expect(row).not.toContainText("Sent to conversation")
      await expect(row).not.toContainText("Waiting for bot")
    }
    await expect(app.getByRole("status")).toHaveCount(0)
    await expect(
      app.getByRole("button", { name: /retry change|replay|resend/i })
    ).toHaveCount(0)
    expect(writes).toEqual([])
    if (pass === 0) await page.reload()
  }
  expect(errors).toEqual([])
})
