import { expect, test, type Page } from "@playwright/test"
import { Schema } from "effect"

import { Task, type MailboxView } from "../../src/communication/contracts"

const savedResult = "The saved meal plan is ready for your review."
const task = (id: string, overrides: Partial<Task> = {}): Task =>
  Schema.decodeUnknownSync(Task)({
    id,
    direction: "outgoing",
    request: {
      version: 1,
      id: `${id}:request`,
      owner: "benchmark-owner",
      from: "home",
      to: "00000000-0000-4000-8000-000000000071",
      taskId: id,
      correlationId: "original-turn",
      causationId: "original-turn",
      createdAt: 1_792_756_800_000,
      deadline: 4_070_908_800_000,
      depth: 0,
      payload: { kind: "task", objective: `Request ${id}`, context: "" },
    },
    status: "completed",
    outcome: { status: "completed", text: savedResult },
    revision: 7,
    leaseUntil: null,
    resumed: false,
    cancelRequested: false,
    schemaVersion: 1,
    workflowVersion: 1,
    control: {
      owner: null,
      phase: "continuation",
      deadline: null,
      attempts: 3,
      unconfirmed: true,
    },
    stop: { status: "none", attempts: 0, deadline: null, nextAt: null },
    ...overrides,
  })

const failedMailbox = (
  epoch: string
): NonNullable<MailboxView["recovery"]> => ({
  schemaVersion: 1,
  workflowVersion: 1,
  epoch,
  failedAt: 1_792_756_800_000,
  discoveryToken: "original-discovery",
  message: `Mailbox recovery ${epoch} could not be confirmed.`,
})

/** Render the built Activity workbench; substitute only server responses.
 * Record every agent POST so recovery can never hide a send/model request. */
async function recoveryPage(page: Page, initial: MailboxView) {
  let current = initial
  const posts: { path: string; agent: string | null; body: unknown }[] = []
  const replies: {
    url: string
    release: (reply: { status: number; error?: string }) => void
  }[] = []
  await page.route("**/api/agent/**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() === "POST") {
      posts.push({
        path: url.pathname,
        agent: url.searchParams.get("agent"),
        body: request.postDataJSON() as unknown,
      })
      if (url.pathname !== "/api/agent/communication/control")
        return route.fulfill({
          status: 409,
          json: { error: "Unexpected mutation in mailbox recovery test." },
        })
      const reply = await new Promise<{ status: number; error?: string }>(
        (release) => replies.push({ url: request.url(), release })
      )
      return route.fulfill({
        status: reply.status,
        json: reply.error ? { error: reply.error } : { ok: true },
      })
    }
    if (url.pathname === "/api/agent/communication")
      return route.fulfill({ json: current })
    if (url.pathname === "/api/agent/plans")
      return route.fulfill({ json: { plans: [], nextOffset: null } })
    if (url.pathname === "/api/agent/access")
      return route.fulfill({ json: { tools: [], approvals: [] } })
    if (url.pathname === "/api/agent/inference")
      return route.fulfill({ json: { attempts: [] } })
    if (
      url.pathname === "/api/agent/background" ||
      url.pathname === "/api/agent/delegations"
    )
      return route.fulfill({ json: { groups: [], nextOffset: null } })
    return route.fallback()
  })
  await page.goto("/agents/home/activity?tab=tasks")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const mailbox = page.getByRole("region", { name: "Bot communication" })
  await expect(mailbox).toBeVisible()
  return {
    mailbox,
    posts,
    open: (id: string) =>
      mailbox
        .getByRole("button", { name: new RegExp(`Request ${id} `) })
        .click(),
    publish: (next: MailboxView) => {
      current = next
    },
    respond: async (index: number, status = 200, error?: string) => {
      const held = replies[index]!
      const received = page.waitForResponse(
        (response) =>
          response.url() === held.url && response.request().method() === "POST"
      )
      held.release({ status, error })
      await received
    },
    releaseAll: () => {
      for (const held of replies) held.release({ status: 200 })
    },
  }
}

const expectedPost = (id: string, action: "retry" | "retry_mailbox") => ({
  path: "/api/agent/communication/control",
  agent: "home",
  body: { id, action },
})

test("Retry result retains the saved outcome and disables mailbox controls while pending", async ({
  page,
}) => {
  const completed = task("saved-result")
  const waiting = task("waiting", {
    status: "waiting",
    outcome: null,
    control: { ...completed.control, unconfirmed: false },
  })
  const initial: MailboxView = {
    tasks: [completed, waiting],
    deliveries: [
      {
        schemaVersion: 1,
        workflowVersion: 1,
        envelope: waiting.request,
        status: "failed",
        attempts: 8,
        attemptLimit: 8,
        nextAt: null,
        error: "The original delivery could not be confirmed.",
        receipt: null,
      },
    ],
    recovery: failedMailbox("failed-epoch"),
  }
  const f = await recoveryPage(page, initial)
  try {
    await f.open(completed.id)
    await f.open(waiting.id)
    const retry = f.mailbox.getByRole("button", {
      name: "Retry result",
      exact: true,
    })
    await expect(retry).toBeEnabled()
    expect(f.posts).toEqual([])
    await retry.dblclick()
    await expect
      .poll(() => f.posts)
      .toEqual([expectedPost(completed.id, "retry")])
    await expect(retry).toBeDisabled()
    await expect(
      f.mailbox.getByRole("button", { name: "Retry mailbox", exact: true })
    ).toBeDisabled()
    await expect(
      f.mailbox.getByRole("button", { name: "Retry delivery", exact: true })
    ).toBeDisabled()
    await expect(
      f.mailbox.getByRole("button", {
        name: "Request cancellation",
        exact: true,
      })
    ).toBeDisabled()
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()

    f.publish({ ...initial, tasks: [{ ...completed, resumed: true }, waiting] })
    await f.respond(0)
    await expect(retry).toHaveCount(0)
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()
    await expect(
      f.mailbox.getByRole("button", { name: "Retry mailbox", exact: true })
    ).toBeEnabled()
    // The exact POST inventory excludes creating a task or sending a model turn.
    expect(f.posts).toEqual([expectedPost(completed.id, "retry")])
  } finally {
    f.releaseAll()
  }
})

test("result recovery errors retain the original task identity and saved output", async ({
  page,
}) => {
  const completed = task("saved-result")
  const f = await recoveryPage(page, {
    tasks: [completed],
    deliveries: [],
    recovery: null,
  })
  try {
    await f.open(completed.id)
    const retry = f.mailbox.getByRole("button", {
      name: "Retry result",
      exact: true,
    })
    await retry.click()
    await expect.poll(() => f.posts).toHaveLength(1)
    await f.respond(
      0,
      503,
      "The saved result could not reconnect. Retry is safe."
    )
    await expect(
      f.mailbox.getByRole("alert").filter({ hasText: "Updates interrupted" })
    ).toContainText("The saved result could not reconnect. Retry is safe.")
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()
    await expect(retry).toBeEnabled()
    await retry.click()
    await expect
      .poll(() => f.posts)
      .toEqual([
        expectedPost(completed.id, "retry"),
        expectedPost(completed.id, "retry"),
      ])
    f.publish({
      tasks: [{ ...completed, resumed: true }],
      deliveries: [],
      recovery: null,
    })
    await f.respond(1)
    await expect(retry).toHaveCount(0)
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()
  } finally {
    f.releaseAll()
  }
})

test("Retry result appears only for outgoing terminal results with unconfirmed continuation", async ({
  page,
}) => {
  const completed = task("saved-result")
  const ineligible = [
    task("incoming", { direction: "incoming" }),
    task("resumed", { resumed: true }),
    task("confirmed", {
      control: { ...completed.control, unconfirmed: false },
    }),
    task("running", { status: "running", outcome: null }),
  ]
  const f = await recoveryPage(page, {
    tasks: ineligible,
    deliveries: [],
    recovery: null,
  })
  try {
    for (const entry of ineligible) await f.open(entry.id)
    await expect(
      f.mailbox.getByRole("button", { name: "Retry result", exact: true })
    ).toHaveCount(0)
    expect(f.posts).toEqual([])
  } finally {
    f.releaseAll()
  }
})

test("Retry mailbox uses the displayed failed epoch and preserves a newer exhaustion after a stale response", async ({
  page,
}) => {
  const completed = task("retained", { resumed: true })
  const initial: MailboxView = {
    tasks: [completed],
    deliveries: [],
    recovery: failedMailbox("epoch-one"),
  }
  const f = await recoveryPage(page, initial)
  try {
    await f.open(completed.id)
    const retry = f.mailbox.getByRole("button", {
      name: "Retry mailbox",
      exact: true,
    })
    await expect(retry).toBeEnabled()
    await retry.dblclick()
    await expect
      .poll(() => f.posts)
      .toEqual([expectedPost("epoch-one", "retry_mailbox")])
    await expect(retry).toBeDisabled()
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()

    f.publish({ ...initial, recovery: failedMailbox("epoch-two") })
    await expect(f.mailbox).toContainText(
      "Mailbox recovery epoch-two could not be confirmed."
    )
    await expect(retry).toBeDisabled()
    await f.respond(0, 409, "This mailbox recovery is no longer current.")
    await expect(f.mailbox).toContainText(
      "This mailbox recovery is no longer current."
    )
    await expect(retry).toBeEnabled()
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()
    await retry.click()
    await expect
      .poll(() => f.posts)
      .toEqual([
        expectedPost("epoch-one", "retry_mailbox"),
        expectedPost("epoch-two", "retry_mailbox"),
      ])
    f.publish({ ...initial, recovery: null })
    await f.respond(1)
    await expect(retry).toHaveCount(0)
    await expect(
      f.mailbox.getByText(savedResult, { exact: true })
    ).toBeVisible()
    expect(f.posts).toEqual([
      expectedPost("epoch-one", "retry_mailbox"),
      expectedPost("epoch-two", "retry_mailbox"),
    ])
  } finally {
    f.releaseAll()
  }
})
