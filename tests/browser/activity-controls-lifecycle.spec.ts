import { expect, test, type Page } from "@playwright/test"

import type { Group } from "../../src/delegation/contracts"
import { resolveRoute } from "../../src/inference/policy"

const original = "00000000-0000-4000-8000-000000000071"
const group: Group = {
  id: 17,
  turnId: "turn-one",
  conversationId: 7,
  objective: "Uncertain private draft",
  route: resolveRoute("conversation", { model: "test", thinking: "off" }),
  createdAt: 1,
  deadline: 9000000000000,
  status: "working",
  children: [],
  background: {
    delivery: "paused",
    error: "Connection needs explicit retry",
    reportId: "report-one",
    stop: "none",
  },
}
async function activity(page: Page, initial: Group) {
  const failures: string[] = [],
    posts: { path: string; body: unknown }[] = [],
    replies: { resolve: (status: number) => void }[] = []
  page.on("pageerror", (error) => failures.push(error.message))
  await page.route("**/api/agent/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname
    if (request.method() === "POST") {
      posts.push({ path, body: request.postDataJSON() as unknown })
      const status = await new Promise<number>((resolve) =>
        replies.push({ resolve })
      )
      return route.fulfill({
        status,
        json:
          status === 200
            ? { ok: true }
            : { error: "Acknowledgement unavailable" },
      })
    }
    if (path === "/api/agent/background")
      return route.fulfill({ json: { groups: [initial], nextOffset: null } })
    if (path === "/api/agent/delegations")
      return route.fulfill({ json: { groups: [], nextOffset: null } })
    if (path === "/api/agent/plans")
      return route.fulfill({ json: { plans: [], nextOffset: null } })
    if (path === "/api/agent/access")
      return route.fulfill({ json: { tools: [], approvals: [] } })
    if (path === "/api/agent/inference")
      return route.fulfill({ json: { attempts: [] } })
    if (path === "/api/agent/communication")
      return route.fulfill({
        json: { tasks: [], deliveries: [], recovery: null },
      })
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
  const region = page.getByRole("region", { name: "Background work" })
  await expect(region).toBeVisible()
  return {
    region,
    posts,
    failures,
    replies,
    releaseAll: () => replies.forEach((reply) => reply.resolve(200)),
  }
}

test("same-task duplicate retry preserves one operation and uncertain acknowledgement", async ({
  page,
}) => {
  const f = await activity(page, group)
  try {
    const retry = f.region.getByRole("button", {
      name: "Retry connection",
      exact: true,
    })
    await expect(retry).toBeEnabled()
    // Two activations before React can render busy used to mint two identities.
    await retry.evaluate((button: HTMLButtonElement) => {
      button.click()
      button.click()
    })
    await expect.poll(() => f.posts.length).toBe(1)
    const saved = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem("background-command:home:17:retry")!)
    )
    expect(f.posts).toEqual([
      {
        path: "/api/agent/background/retry",
        body: { groupId: 17, operationId: saved.operationId },
      },
    ])
    await expect(
      f.region.getByRole("button", { name: "Sending…" }).first()
    ).toBeDisabled()
    f.replies[0]!.resolve(503)
    await expect(
      f.region.getByText("Acknowledgement unavailable", { exact: true })
    ).toBeVisible()
    await expect(retry).toBeEnabled()
    await expect(
      f.region.getByRole("button", { name: "Stop group", exact: true })
    ).toBeEnabled()
    await retry.click()
    await expect.poll(() => f.posts.length).toBe(2)
    expect(f.posts[1]).toEqual(f.posts[0])
    f.replies[1]!.resolve(200)
    await expect
      .poll(() =>
        page.evaluate(() =>
          sessionStorage.getItem("background-command:home:17:retry")
        )
      )
      .toBeNull()
    await expect(f.region.getByText("paused", { exact: true })).toBeVisible()
    expect(f.failures).toEqual([])
  } finally {
    f.releaseAll()
  }
})

test("saved steering survives reload with its original text and operation", async ({
  page,
}) => {
  const body = {
    groupId: 17,
    childId: 19,
    operationId: original,
    action: { type: "steer", text: "Keep the original private brief" },
  }
  const key = "background:delegation-control:home:17:19:steer"
  await page.addInitScript(
    ({ key, body }) => {
      if (!sessionStorage.getItem("seeded-steering")) {
        sessionStorage.setItem(key, JSON.stringify(body))
        sessionStorage.setItem("seeded-steering", "yes")
      }
    },
    { key, body }
  )
  const f = await activity(page, {
    ...group,
    children: [
      {
        id: 19,
        name: "Research",
        task: "Read the saved brief",
        tools: [],
        status: "working",
        answer: "Retained partial findings",
        requests: 1,
        inputTokens: null,
        outputTokens: null,
        steering: [],
        error: null,
      },
    ],
  })
  try {
    const text = f.region.getByLabel("Steer Research", { exact: true })
    await expect(text).toHaveValue(body.action.text)
    await expect(text).toBeDisabled()
    await expect(
      f.region.getByRole("button", { name: "Stop task", exact: true })
    ).toBeEnabled()
    expect(f.posts).toEqual([])
    await f.region
      .getByRole("button", { name: "Retry saved steer", exact: true })
      .click()
    await expect.poll(() => f.posts.length).toBe(1)
    f.replies[0]!.resolve(503)
    await expect(
      f.region.getByText("Acknowledgement unavailable", { exact: true }).first()
    ).toBeVisible()
    await page.reload()
    await expect(text).toHaveValue(body.action.text)
    expect(f.posts).toHaveLength(1)
    await f.region
      .getByRole("button", { name: "Retry saved steer", exact: true })
      .click()
    await expect.poll(() => f.posts.length).toBe(2)
    expect(f.posts).toEqual([
      { path: "/api/agent/background/control", body },
      { path: "/api/agent/background/control", body },
    ])
    f.replies[1]!.resolve(200)
    await expect(text).toHaveValue("")
    await expect(text).toBeEnabled()
    await expect(
      f.region.getByText("Retained partial findings", { exact: true })
    ).toBeVisible()
    expect(f.failures).toEqual([])
  } finally {
    f.releaseAll()
  }
})

test("unconfirmed remote stop retains its saved retry and is never displayed as stopped", async ({
  page,
}) => {
  const body = { groupId: 17, operationId: original, action: "stop" }
  await page.addInitScript(
    (body) =>
      sessionStorage.setItem(
        "background-command:home:17:stop",
        JSON.stringify(body)
      ),
    body
  )
  const f = await activity(page, {
    ...group,
    status: "cancelled",
    background: {
      ...group.background!,
      delivery: "cancelled",
      stop: "unconfirmed",
    },
    children: [
      {
        id: 19,
        name: "Research",
        task: "Read the saved brief",
        tools: [],
        status: "working",
        answer: "Saved findings",
        requests: 1,
        inputTokens: null,
        outputTokens: null,
        steering: [],
        error: null,
      },
    ],
  })
  try {
    await expect(
      f.region.getByText("Stop unconfirmed", { exact: true }).first()
    ).toBeVisible()
    await expect(
      f.region.getByText("Stopped with parent", { exact: true })
    ).toHaveCount(0)
    expect(f.posts).toEqual([])
    await f.region
      .getByRole("button", { name: "Retry stop", exact: true })
      .click()
    await expect
      .poll(() => f.posts)
      .toEqual([
        {
          path: "/api/agent/background/stop",
          body: { groupId: 17, operationId: original },
        },
      ])
    f.replies[0]!.resolve(200)
    await expect(
      f.region.getByText("Stop unconfirmed", { exact: true }).first()
    ).toBeVisible()
    expect(f.failures).toEqual([])
  } finally {
    f.releaseAll()
  }
})
