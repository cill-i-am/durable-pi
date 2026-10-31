import { expect, test, type Page } from "@playwright/test"

import type { ChatState } from "../../src/conversations/contracts"

type Memory = ChatState["memory"]
const note =
  "The original messages and this completed memory note remain saved."
const initial: Memory = {
  messages: 4,
  summaries: 1,
  ready: false,
  issues: [{ start: 0, count: 2, attempts: 1, retryAt: null }],
  compactionRecovery: {
    epoch: "scheduler-first",
    failedAt: 100,
    message: "The memory scheduler stopped after storage became unavailable.",
  },
  notes: [
    {
      path: "Saved memory",
      body: note,
      source_id: 1,
      updated_at: "2026-10-23T12:00:00Z",
    },
  ],
}

async function recoveryPage(page: Page, memory: Memory = initial) {
  let current = memory
  let snapshots = 0
  const errors: string[] = []
  const external: string[] = []
  const posts: { path: string; agent: string | null; body: unknown }[] = []
  const pending: { url: string; release: (status: number) => void }[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin === "http://127.0.0.1:4399") return route.fallback()
    external.push(url.href)
    return route.abort()
  })
  await page.route("**/api/agent/**", async (route) => {
    const request = route.request()
    if (request.method() !== "POST") return route.fallback()
    const url = new URL(request.url())
    posts.push({
      path: url.pathname,
      agent: url.searchParams.get("agent"),
      body: request.postDataJSON() as unknown,
    })
    if (
      ![
        "/api/agent/memory/retry",
        "/api/agent/memory/retry_compaction",
        "/api/agent/memory/backup/retry",
        "/api/agent/memory/backup/recover",
      ].includes(url.pathname)
    )
      return route.fulfill({
        status: 409,
        json: { error: "Unexpected mutation." },
      })
    const status = await new Promise<number>((release) =>
      pending.push({ url: request.url(), release })
    )
    return route.fulfill({
      status,
      json:
        status < 400
          ? { ok: true }
          : {
              error:
                status === 409
                  ? "This recovery epoch has changed. Check the current memory status."
                  : "The retry response could not be confirmed.",
            },
    })
  })
  await page.route("**/api/agent/events?**", async (route) => {
    const frames = [
      { type: "MESSAGES_SNAPSHOT", messages: [] },
      {
        type: "CUSTOM",
        name: "durable-pi.metadata",
        value: { model: "test", connected: true, memory: current },
      },
    ]
    await route.fulfill({
      contentType: "text/event-stream",
      body: frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
    snapshots++
  })
  await page.goto("/agents/home/memory")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi\/memory$/)
  await expect(page.getByText(note, { exact: true })).toBeVisible()
  const recovery = page.locator('[aria-label="Memory recovery"]')
  await expect(recovery).toBeVisible()
  return {
    recovery,
    posts,
    errors,
    external,
    snapshots: () => snapshots,
    publish: (memory: Memory) => {
      current = memory
    },
    respond: async (index: number, status = 200) => {
      const held = pending[index]!
      const received = page.waitForResponse(
        (response) =>
          response.url() === held.url && response.request().method() === "POST"
      )
      held.release(status)
      await received
    },
    releaseAll: () => {
      for (const request of pending) request.release(503)
    },
  }
}

for (const staleStatus of [200, 409]) {
  test(`scheduler recovery uses the exact epoch and a stale ${staleStatus} response cannot clear a newer failure`, async ({
    page,
  }) => {
    const f = await recoveryPage(page)
    try {
      const scheduler = f.recovery.getByRole("button", {
        name: "Retry compaction scheduler",
        exact: true,
      })
      const summary = f.recovery.getByRole("button", {
        name: "Retry summary 0+2",
        exact: true,
      })
      await expect(scheduler).toBeEnabled()
      await expect(summary).toBeEnabled()
      await expect.poll(f.snapshots).toBeGreaterThan(1)
      expect(f.posts).toEqual([])
      await scheduler.click()
      await expect
        .poll(() => f.posts)
        .toEqual([
          {
            path: "/api/agent/memory/retry_compaction",
            agent: "home",
            body: { epoch: "scheduler-first" },
          },
        ])
      await expect(
        f.recovery.getByRole("button", {
          name: "Retrying scheduler…",
          exact: true,
        })
      ).toBeDisabled()
      await expect(summary).toBeDisabled()
      const next = {
        ...initial,
        compactionRecovery: {
          epoch: "scheduler-second",
          failedAt: 200,
          message: "A newer storage failure needs attention.",
        },
      }
      f.publish(next)
      await expect(f.recovery).toContainText(next.compactionRecovery.message)
      await f.respond(0, staleStatus)
      await expect(scheduler).toBeEnabled()
      await expect(f.recovery).toContainText(next.compactionRecovery.message)
      await expect(f.recovery.getByRole("status")).toHaveCount(0)
      await expect(
        f.recovery.getByText(
          "This recovery epoch has changed. Check the current memory status.",
          { exact: true }
        )
      ).toHaveCount(0)
      expect(f.posts).toHaveLength(1)
      await scheduler.click()
      await expect.poll(() => f.posts.length).toBe(2)
      expect(f.posts[1]).toEqual({
        path: "/api/agent/memory/retry_compaction",
        agent: "home",
        body: { epoch: "scheduler-second" },
      })
      await f.respond(1, 409)
      await expect(f.recovery).toContainText(
        "This recovery epoch has changed. Check the current memory status."
      )
      await expect(scheduler).toBeEnabled()
      expect(f.posts).toHaveLength(2)
      await scheduler.click()
      await expect.poll(() => f.posts.length).toBe(3)
      await f.respond(2)
      await expect(scheduler).toBeDisabled()
      await expect(f.recovery.getByRole("status")).toContainText(
        "Waiting for updated memory status."
      )
      await expect(f.recovery).toContainText(next.compactionRecovery.message)
      f.publish({ ...initial, compactionRecovery: undefined })
      await expect(scheduler).toHaveCount(0)
      await expect(summary).toBeEnabled()
      await expect(page.getByText(note, { exact: true })).toBeVisible()
      expect(
        f.posts.every(
          (post) => post.path === "/api/agent/memory/retry_compaction"
        )
      ).toBe(true)
      expect(f.errors).toEqual([])
      expect(f.external).toEqual([])
    } finally {
      f.releaseAll()
    }
  })
}

test("paused summaries preserve their operation ID after an uncertain response and reload until explicit retry succeeds", async ({
  page,
}) => {
  const f = await recoveryPage(page, {
    ...initial,
    compactionRecovery: undefined,
  })
  try {
    const summary = f.recovery.getByRole("button", {
      name: "Retry summary 0+2",
      exact: true,
    })
    await expect(f.recovery).toContainText("explicitly starts a new attempt")
    await expect(f.recovery).not.toContainText("three unsuccessful attempts")
    await expect(summary).toBeEnabled()
    expect(f.posts).toEqual([])
    await summary.click()
    await expect.poll(() => f.posts.length).toBe(1)
    const first = f.posts[0]!
    expect(first).toMatchObject({
      path: "/api/agent/memory/retry",
      agent: "home",
      body: { start: 0, count: 2, operationId: expect.any(String) },
    })
    await expect(
      f.recovery.getByRole("button", { name: "Retrying…", exact: true })
    ).toBeDisabled()
    await f.respond(0, 503)
    await expect(f.recovery).toContainText(
      "The retry response could not be confirmed."
    )
    await expect(summary).toBeEnabled()
    await page.reload()
    await expect(summary).toBeEnabled()
    await expect(page.getByText(note, { exact: true })).toBeVisible()
    expect(f.posts).toHaveLength(1)
    await summary.click()
    await expect.poll(() => f.posts.length).toBe(2)
    expect(f.posts[1]).toEqual(first)
    await f.respond(1)
    await expect(summary).toBeEnabled()
    await expect(f.recovery.getByRole("status")).toContainText(
      "Waiting for updated memory status."
    )
    await expect(f.recovery).toContainText("Memory summaries paused")
    f.publish({
      ...initial,
      compactionRecovery: undefined,
      issues: [],
      ready: true,
    })
    await expect(summary).toHaveCount(0)
    await expect(page.getByText(note, { exact: true })).toBeVisible()
    expect(f.posts).toHaveLength(2)
    expect(f.errors).toEqual([])
    expect(f.external).toEqual([])
  } finally {
    f.releaseAll()
  }
})

test("backup retry keeps the failed receipt and last complete backup until authoritative status changes", async ({
  page,
}) => {
  const backup = {
    date: "2026-10-22T12:00:00Z",
    error: "Backup publication needs attention.",
    recovery: { attemptId: "backup-first", target: "watermark-first" },
  }
  const f = await recoveryPage(page, { ...initial, backup })
  try {
    await page.getByRole("tab", { name: "Archive", exact: true }).click()
    const panel = page.locator('[aria-label="Backup recovery"]')
    const retry = panel.getByRole("button", {
      name: "Retry backup",
      exact: true,
    })
    await expect(retry).toBeEnabled()
    await expect(page.getByText(backup.error, { exact: true })).toBeVisible()
    expect(f.posts).toEqual([])
    await retry.click()
    await expect
      .poll(() => f.posts)
      .toEqual([
        {
          path: "/api/agent/memory/backup/retry",
          agent: "home",
          body: backup.recovery,
        },
      ])
    await expect(
      panel.getByRole("button", { name: "Retrying backup…", exact: true })
    ).toBeDisabled()
    const newer = {
      ...backup,
      error: "A newer backup needs attention.",
      recovery: { attemptId: "backup-second", target: "watermark-second" },
    }
    f.publish({ ...initial, backup: newer })
    await expect(page.getByText(newer.error, { exact: true })).toBeVisible()
    await f.respond(0)
    await expect(retry).toBeEnabled()
    await expect(panel.getByRole("status")).toHaveCount(0)
    await expect(page.getByText(newer.error, { exact: true })).toBeVisible()
    await retry.click()
    await expect.poll(() => f.posts.length).toBe(2)
    expect(f.posts[1]).toEqual({
      path: "/api/agent/memory/backup/retry",
      agent: "home",
      body: newer.recovery,
    })
    await f.respond(1, 503)
    await expect(panel.getByRole("alert")).toContainText(
      "could not be confirmed"
    )
    await expect(retry).toBeEnabled()
    expect(f.posts).toHaveLength(2)
    await retry.click()
    await expect.poll(() => f.posts.length).toBe(3)
    expect(f.posts[2]).toEqual(f.posts[1])
    await f.respond(2)
    await expect(retry).toBeDisabled()
    await expect(panel.getByRole("status")).toContainText(
      "Waiting for updated backup status."
    )
    await expect(page.getByText(newer.error, { exact: true })).toBeVisible()
    f.publish({
      ...initial,
      backup: { ...backup, error: null, recovery: null },
    })
    await expect(panel).toHaveCount(0)
    await expect(page.getByText(/Last complete backup:/)).toBeVisible()
    await expect(
      page.getByRole("link", { name: "Readable HTML", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Import history", exact: true })
    ).toBeDisabled()
    expect(
      f.posts.every((post) => post.path === "/api/agent/memory/backup/retry")
    ).toBe(true)
    expect(f.errors).toEqual([])
    expect(f.external).toEqual([])
  } finally {
    f.releaseAll()
  }
})

test("backup scheduler exhaustion offers exact epoch recovery without starting a backup attempt", async ({
  page,
}) => {
  const schedulerRecovery = {
    epoch: "backup-scheduler-first",
    failedAt: 100,
    message: "Backup discovery stopped before work could be claimed.",
  }
  const f = await recoveryPage(page, {
    ...initial,
    backup: { date: null, error: null, recovery: null, schedulerRecovery },
  })
  try {
    await page.getByRole("tab", { name: "Archive", exact: true }).click()
    const panel = page.locator('[aria-label="Backup recovery"]')
    const scheduler = panel.getByRole("button", {
      name: "Retry backup recovery",
      exact: true,
    })
    await expect(scheduler).toBeEnabled()
    await expect(panel).toContainText(schedulerRecovery.message)
    await expect(
      panel.getByRole("button", { name: "Retry backup", exact: true })
    ).toHaveCount(0)
    expect(f.posts).toEqual([])
    await scheduler.click()
    await expect
      .poll(() => f.posts)
      .toEqual([
        {
          path: "/api/agent/memory/backup/recover",
          agent: "home",
          body: { epoch: schedulerRecovery.epoch },
        },
      ])
    await expect(
      panel.getByRole("button", {
        name: "Retrying backup recovery…",
        exact: true,
      })
    ).toBeDisabled()
    const next = {
      epoch: "backup-scheduler-second",
      failedAt: 200,
      message: "A newer backup scheduler failure needs attention.",
    }
    const backup = {
      date: null,
      error: "A backup also needs attention.",
      recovery: { attemptId: "retained-backup", target: "retained-target" },
      schedulerRecovery: next,
    }
    f.publish({ ...initial, backup })
    await expect(panel).toContainText(next.message)
    await f.respond(0)
    await expect(scheduler).toBeEnabled()
    await expect(panel).toContainText(next.message)
    await expect(panel.getByRole("status")).toHaveCount(0)
    await expect(
      panel.getByRole("button", { name: "Retry backup", exact: true })
    ).toHaveCount(0)
    await scheduler.click()
    await expect.poll(() => f.posts.length).toBe(2)
    expect(f.posts[1]).toEqual({
      path: "/api/agent/memory/backup/recover",
      agent: "home",
      body: { epoch: next.epoch },
    })
    await f.respond(1, 409)
    await expect(panel.getByRole("alert")).toContainText(
      "could not be confirmed"
    )
    await expect(scheduler).toBeEnabled()
    expect(f.posts).toHaveLength(2)
    await scheduler.click()
    await expect.poll(() => f.posts.length).toBe(3)
    await f.respond(2)
    await expect(scheduler).toBeDisabled()
    await expect(panel).toContainText(next.message)
    f.publish({ ...initial, backup: { ...backup, schedulerRecovery: null } })
    await expect(scheduler).toHaveCount(0)
    await expect(
      panel.getByRole("button", { name: "Retry backup", exact: true })
    ).toBeEnabled()
    expect(
      f.posts.every((post) => post.path === "/api/agent/memory/backup/recover")
    ).toBe(true)
    expect(f.posts).toHaveLength(3)
    expect(f.errors).toEqual([])
    expect(f.external).toEqual([])
  } finally {
    f.releaseAll()
  }
})
