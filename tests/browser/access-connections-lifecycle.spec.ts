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

test("approval keeps exact inputs and decision identity across an uncertain acknowledgement", async ({
  page,
}) => {
  const failures = errors(page),
    posts: unknown[] = []
  let release!: () => void
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "MESSAGES_SNAPSHOT",
          messages: chatMessages([
            {
              id: "turn-one",
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
            access: { tools: [policy], approvals: [approval] },
          },
        },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  )
  await page.route("**/api/agent/access/decide?**", async (route) => {
    posts.push(route.request().postDataJSON())
    if (posts.length === 1) {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return route.fulfill({
        status: 503,
        json: { error: "Acknowledgement unavailable" },
      })
    }
    return route.fulfill({ json: { tools: [policy], approvals: [] } })
  })
  await login(page, "/agents/home")
  const card = page.getByRole("region", { name: "Approval for Write a note" })
  await expect(card).toBeVisible()
  await card.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(
    card.getByRole("button", { name: "Saving decision…" })
  ).toBeDisabled()
  await expect(
    card.getByRole("button", { name: "Deny", exact: true })
  ).toBeDisabled()
  await expect(
    card.getByText('"original exact input"', { exact: false })
  ).toBeVisible()
  release()
  await expect(card.getByRole("alert")).toContainText("could not be confirmed")
  await expect(
    card.getByRole("button", { name: "Deny", exact: true })
  ).toBeDisabled()
  await expect(
    card.getByRole("button", { name: "Always allow", exact: true })
  ).toBeDisabled()
  expect(posts).toHaveLength(1)
  await card.getByRole("button", { name: "Allow once", exact: true }).click()
  await expect(card).toContainText("Approved for this action")
  expect(posts).toEqual([
    { id: approval.id, approve: true, expectedRevision: 4 },
    { id: approval.id, approve: true, expectedRevision: 4 },
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
  const failures = errors(page)
  const posts: unknown[] = []
  let current: AccessState = { tools: [policy], approvals: [approval] }
  let release!: () => void
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "MESSAGES_SNAPSHOT",
          messages: chatMessages([
            {
              id: "turn-one",
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
            access: current,
          },
        },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  )
  await page.route("**/api/agent/access/decide?**", async (route) => {
    posts.push(route.request().postDataJSON())
    await new Promise<void>((resolve) => {
      release = resolve
    })
    await route.fulfill({
      json: {
        tools: [{ ...policy, mode: "allow", revision: 3 }],
        approvals: [],
      },
    })
  })
  await login(page, "/agents/home")
  const card = page.getByRole("region", {
    name: "Approval for Write a note",
    exact: true,
  })
  await card.getByRole("button", { name: "Always allow", exact: true }).click()
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
  const updated = page.getByRole("region", {
    name: "Approval for Newer denied note policy",
    exact: true,
  })
  await expect(updated).toBeVisible()
  release()
  await expect(updated).toContainText("Approved for this action")
  await expect(updated).not.toContainText("Tool allowed for this agent")
  expect(posts).toEqual([
    {
      id: approval.id,
      expectedRevision: 4,
      approve: true,
      remember: { expectedPolicyRevision: 2 },
    },
  ])
  expect(failures).toEqual([])
})
