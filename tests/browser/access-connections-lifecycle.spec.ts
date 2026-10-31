import { expect, test, type Page } from "@playwright/test"

import type { ConnectionInfo } from "../../src/access/connections"
import type { AccessState, Approval } from "../../src/access/contracts"
import { chatMessages } from "../../src/conversations/adapters/tanstack"

const policy = {
  name: "write_note",
  title: "Write a note",
  description: "Save a note",
  mode: "ask" as const,
  revision: 2,
}
const approval: Approval = {
  id: "approval-one",
  turnId: "turn-one",
  tool: policy.name,
  input: '{"note":"original exact input"}',
  createdAt: 1,
  expiresAt: 9000000000000,
  status: "pending",
  revision: 4,
}
const connection: ConnectionInfo = {
  id: `mcp-${"a".repeat(32)}`,
  name: "Original tools",
  url: "https://tools.example.com/mcp",
  revision: 3,
  active: true,
  status: "unavailable",
  authorizeUrl: null,
  tools: [],
}
async function login(page: Page, path: string) {
  await page.goto(path)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
}
function errors(page: Page) {
  const values: string[] = []
  page.on("pageerror", (error) => values.push(error.message))
  return values
}

function approvalStream(access: AccessState) {
  return [
    {
      type: "MESSAGES_SNAPSHOT",
      messages: chatMessages([
        {
          id: approval.turnId,
          status: "running",
          text: "Please write a note",
          answer: "",
          error: null,
          created_at: "2026-10-23T00:00:00Z",
        },
      ]),
    },
    {
      type: "CUSTOM",
      name: "durable-pi.metadata",
      value: {
        model: "test",
        connected: true,
        memory: { messages: 1, summaries: 0, ready: true, notes: [] },
        access,
      },
    },
  ]
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join("")
}

test("approval keeps exact inputs and decision identity across an uncertain acknowledgement", async ({
  page,
}) => {
  const failures = errors(page),
    posts: unknown[] = []
  let current: AccessState = { tools: [policy], approvals: [approval] }
  let reads = 0,
    release!: () => void
  await page.route("**/api/agent/events?**", (route) => {
    reads++
    return route.fulfill({
      contentType: "text/event-stream",
      body: approvalStream(current),
    })
  })
  await page.route("**/api/agent/access/decide?**", async (route) => {
    posts.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return route.fulfill({
      status: 503,
      json: { error: "Acknowledgement unavailable" },
    })
  })
  await login(page, "/agents/home")
  const dock = page.getByRole("region", {
    name: "Decisions awaiting approval",
    exact: true,
  })
  const receipt = page.getByRole("region", {
    name: "Approval for Write a note",
    exact: true,
  })
  await expect(dock).toBeVisible()
  await expect(receipt).toHaveCount(0)
  await dock.getByRole("button", { name: "Review action", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Write a note", exact: true })
  const exactInputs = JSON.stringify(JSON.parse(approval.input), null, 2)
  await expect(
    detail.getByRole("heading", { name: "Complete action inputs", exact: true })
  ).toBeVisible()
  await expect(detail.locator("pre")).toHaveText(exactInputs)
  await detail.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(
    detail.getByRole("button", { name: "Saving decision…", exact: true })
  ).toBeDisabled()
  await expect(
    detail.getByRole("button", { name: "Deny", exact: true })
  ).toBeDisabled()
  await expect(detail.locator("pre")).toHaveText(exactInputs)
  expect(posts).toEqual([
    { id: approval.id, approve: true, expectedRevision: approval.revision },
  ])
  release()
  await expect(detail.getByRole("alert")).toContainText(
    "could not be confirmed"
  )
  await expect(
    detail.getByRole("button", { name: "Allow once", exact: true })
  ).toHaveCount(0)
  await expect(
    detail.getByRole("button", { name: "Deny", exact: true })
  ).toHaveCount(0)
  await expect(
    detail.getByRole("button", { name: "Always allow", exact: true })
  ).toHaveCount(0)
  const beforeUnknownCheck = reads
  await detail
    .getByRole("button", { name: "Check status", exact: true })
    .click()
  await expect.poll(() => reads).toBeGreaterThan(beforeUnknownCheck)
  await expect(
    detail.getByRole("button", { name: "Check status", exact: true })
  ).toBeVisible()
  await expect(detail.locator("pre")).toHaveText(exactInputs)
  expect(posts).toHaveLength(1)
  await expect(receipt).toHaveCount(0)

  // Only a read of durable status resolves the uncertainty. This does not
  // authorize another send or claim that the approved action has executed.
  current = {
    tools: [policy],
    approvals: [
      { ...approval, status: "approved", revision: approval.revision + 1 },
    ],
  }
  const beforeConfirmedCheck = reads
  await detail
    .getByRole("button", { name: "Check status", exact: true })
    .click()
  await expect.poll(() => reads).toBeGreaterThan(beforeConfirmedCheck)
  await expect(receipt).toContainText("Approval accepted · waiting to run")
  await expect(receipt).not.toContainText("Action completed")
  await expect(detail).toHaveCount(0)
  await expect(dock).toHaveCount(0)
  await receipt.getByText("Action inputs", { exact: true }).click()
  await expect(receipt.locator("pre")).toHaveText(exactInputs)
  expect(posts).toEqual([
    { id: approval.id, approve: true, expectedRevision: approval.revision },
  ])
  expect(failures).toEqual([])
})

test("policy mutation is serialized and an uncertain response cannot grant permission", async ({
  page,
}) => {
  const failures = errors(page)
  let state: AccessState = { tools: [policy], approvals: [] },
    release!: () => void,
    posts = 0
  await page.route("**/api/agent/access**", async (route) => {
    if (route.request().method() === "POST") {
      posts++
      expect(route.request().postDataJSON()).toEqual({
        name: policy.name,
        expectedRevision: 2,
        mode: "allow",
      })
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return route.fulfill({
        status: 503,
        json: { error: "No acknowledgement" },
      })
    }
    return route.fulfill({ json: state })
  })
  await login(page, "/agents/home/settings/access")
  const group = page.getByRole("group", { name: "Access for Write a note" })
  await group.getByRole("button", { name: "Allow", exact: true }).click()
  await expect(
    group.getByRole("button", { name: "Deny", exact: true })
  ).toBeDisabled()
  release()
  await expect(
    page.getByText("The permission change could not be confirmed.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    group.getByRole("button", { name: "Ask", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  state = { tools: [{ ...policy, mode: "deny", revision: 3 }], approvals: [] }
  await page.getByRole("button", { name: "Reload", exact: true }).click()
  await expect(
    group.getByRole("button", { name: "Deny", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  expect(posts).toBe(1)
  expect(failures).toEqual([])
})

test("uncertain reconnect retains its expected revision and shows the SDK authorization status", async ({
  page,
}) => {
  const failures = errors(page),
    posts: unknown[] = []
  let release!: () => void
  await page.route("**/api/agent/remote-tools?**", (route) =>
    route.fulfill({ json: { revision: 0, tools: [] } })
  )
  await page.route("**/api/agent/connections**", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: { connections: [connection] } })
    expect(new URL(route.request().url()).pathname).toBe(
      "/api/agent/connections/reconnect"
    )
    posts.push(route.request().postDataJSON())
    if (posts.length === 1) return route.abort("failed")
    await new Promise<void>((resolve) => {
      release = resolve
    })
    return route.fulfill({
      json: {
        connections: [
          {
            ...connection,
            revision: 4,
            status: "authorization",
            authorizeUrl: "https://provider.example.com/authorize",
          },
        ],
      },
    })
  })
  await login(page, "/settings/connections")
  const reconnect = page.getByRole("button", { name: "Reconnect", exact: true })
  await reconnect.click()
  await expect(
    page.getByText("The change could not be confirmed.", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Disconnect", exact: true })
  ).toBeDisabled()
  await expect(
    page
      .getByRole("region", { name: "Connections", exact: true })
      .getByText("Unavailable", { exact: true })
  ).toBeVisible()
  expect(posts).toHaveLength(1)
  await reconnect.click()
  await expect(reconnect).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeDisabled()
  release()
  await expect(page.getByText("Sign-in needed", { exact: true })).toBeVisible()
  expect(posts).toEqual([
    { id: connection.id, expectedRevision: 3 },
    { id: connection.id, expectedRevision: 3 },
  ])
  expect(failures).toEqual([])
})

test("a superseded catalog response cannot replace the latest catalog", async ({
  page,
}) => {
  const failures = errors(page)
  let reads = 0,
    release!: () => void
  await page.route("**/api/agent/remote-tools?**", (route) =>
    route.fulfill({ json: { revision: 0, tools: [] } })
  )
  await page.route("**/api/agent/connections?**", async (route) => {
    reads++
    if (reads === 1) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return route
        .fulfill({ json: { connections: [connection] } })
        .catch(() => {})
    }
    return route.fulfill({
      json: {
        connections: [{ ...connection, name: "Newest catalog", revision: 4 }],
      },
    })
  })
  await login(page, "/settings/connections")
  await expect.poll(() => reads).toBe(1)
  await page.getByRole("button", { name: "Loading…", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Newest catalog", exact: true })
  ).toBeVisible()
  release()
  await expect(
    page.getByRole("heading", { name: "Original tools", exact: true })
  ).toHaveCount(0)
  expect(reads).toBe(2)
  expect(failures).toEqual([])
})

test("a late Always allow acknowledgement cannot overwrite a newer denied policy", async ({
  page,
}) => {
  const failures = errors(page),
    posts: unknown[] = []
  let current: AccessState = { tools: [policy], approvals: [approval] }
  let release!: () => void
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: approvalStream(current),
    })
  )
  await page.route("**/api/agent/access?**", (route) =>
    route.fulfill({ json: current })
  )
  await page.route("**/api/agent/access/decide?**", async (route) => {
    posts.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => {
      release = resolve
    })
    current = {
      ...current,
      approvals: [
        { ...approval, status: "approved", revision: approval.revision + 1 },
      ],
    }
    await route.fulfill({
      json: {
        tools: [{ ...policy, mode: "allow", revision: 3 }],
        approvals: current.approvals,
      },
    })
  })
  await login(page, "/agents/home")
  const dock = page.getByRole("region", {
    name: "Decisions awaiting approval",
    exact: true,
  })
  await dock.getByRole("button", { name: "Review action", exact: true }).click()
  const detail = page.getByRole("dialog", { name: "Write a note", exact: true })
  await expect(detail.locator("pre")).toHaveText(
    JSON.stringify(JSON.parse(approval.input), null, 2)
  )
  await detail
    .getByRole("button", { name: "Always allow", exact: true })
    .click()
  await expect.poll(() => posts.length).toBe(1)
  current = {
    ...current,
    tools: [
      {
        ...policy,
        title: "Newer denied note policy",
        mode: "deny",
        revision: 4,
      },
    ],
  }
  const updatedDetail = page.getByRole("dialog", {
    name: "Newer denied note policy",
    exact: true,
  })
  await expect(updatedDetail).toBeVisible()
  release()
  const receipt = page.getByRole("region", {
    name: "Approval for Newer denied note policy",
    exact: true,
  })
  await expect(receipt).toContainText("Approval accepted · waiting to run")
  await expect(receipt).not.toContainText("Tool allowed for this agent")
  await expect(updatedDetail).toHaveCount(0)
  expect(posts).toEqual([
    {
      id: approval.id,
      expectedRevision: approval.revision,
      approve: true,
      remember: { expectedPolicyRevision: policy.revision },
    },
  ])

  // The late reply acknowledges only that action. The next approval round must
  // still use the newer denied policy, including its future-permission fence.
  current = {
    ...current,
    approvals: [
      {
        ...approval,
        id: "approval-next",
        input: '{"note":"new approval round"}',
        revision: 0,
      },
    ],
  }
  await expect(dock).toBeVisible()
  await dock.getByRole("button", { name: "Review action", exact: true }).click()
  const nextDetail = page.getByRole("dialog", {
    name: "Newer denied note policy",
    exact: true,
  })
  await expect(nextDetail.locator("pre")).toHaveText(
    JSON.stringify({ note: "new approval round" }, null, 2)
  )
  await expect(
    nextDetail.getByRole("button", { name: "Allow once", exact: true })
  ).toBeEnabled()
  await expect(
    nextDetail.getByRole("button", { name: "Always allow", exact: true })
  ).toBeDisabled()
  expect(posts).toHaveLength(1)
  await page.getByRole("button", { name: "Close sheet", exact: true }).click()
  await expect(nextDetail).toHaveCount(0)
  await page.goto("/agents/home/settings/access")
  const group = page.getByRole("group", {
    name: "Access for Newer denied note policy",
    exact: true,
  })
  await expect(
    group.getByRole("button", { name: "Deny", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  expect(current.tools[0]!.revision).toBe(4)
  expect(posts).toHaveLength(1)
  expect(failures).toEqual([])
})
