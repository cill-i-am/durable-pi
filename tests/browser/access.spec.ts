import { expect, test } from "@playwright/test"

import type { AccessState } from "../../src/access/contracts"

test("refresh tool access before the next conversation and persist an override", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let reads = 0
  let state: AccessState = {
    tools: [
      {
        name: "mcp_executor_search",
        title: "Executor / search",
        description: "Search connected apps.",
        mode: "allow",
        revision: 0,
      },
    ],
    approvals: [],
  }
  await page.route("**/api/agent/access**", async (route) => {
    const request = route.request()
    if (request.method() === "GET") reads++
    else {
      expect(request.postDataJSON()).toEqual({
        name: "mcp_executor_search",
        expectedRevision: 0,
        mode: "deny",
      })
      state = {
        ...state,
        tools: [{ ...state.tools[0]!, mode: "deny", revision: 1 }],
      }
    }
    await route.fulfill({ json: state })
  })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.goto("/agents/home/settings/access")
  const policy = page.getByRole("group", {
    name: "Access for Executor / search",
  })
  await expect(
    policy.getByRole("button", { name: "Allow", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await policy.getByRole("button", { name: "Deny", exact: true }).click()
  await expect(
    policy.getByRole("button", { name: "Deny", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await page.reload()
  await expect(
    policy.getByRole("button", { name: "Deny", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  expect(reads).toBeGreaterThanOrEqual(2)
  expect(errors).toEqual([])
})

test("tool filtering finds names, descriptions and recovery without changing permissions", async ({
  page,
  isMobile,
}) => {
  const tools: AccessState["tools"] = [
    {
      name: "search_memory",
      title: "Search memory",
      description: "Search this assistant's conversation archive.",
      mode: "ask",
      revision: 4,
    },
    {
      name: "mcp_calendar",
      title: "Calendar / read events",
      description: "Read family dates.",
      mode: "allow",
      revision: 2,
    },
    {
      name: "read_file",
      title: "Read a file",
      description: "Read private documents.",
      mode: "deny",
      revision: 1,
    },
  ]
  const writes: unknown[] = []
  await page.route("**/api/agent/access**", async (route) => {
    if (route.request().method() === "POST")
      writes.push(route.request().postDataJSON())
    await route.fulfill({ json: { tools, approvals: [] } })
  })
  await page.goto("/agents/home/settings/access")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const filter = page.getByRole("textbox", {
    name: "Filter tools",
    exact: true,
  })
  await expect(filter).toBeVisible()
  for (const width of isMobile ? [320, 390] : [800, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    await filter.fill("  SEARCH_MEMORY  ")
    await expect(page.locator(".settings-access-row")).toHaveCount(1)
    const memory = page.getByRole("group", {
      name: "Access for Search memory",
      exact: true,
    })
    await expect(
      memory.getByRole("button", { name: "Ask", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    await filter.fill("Calendar")
    await expect(page.locator(".settings-access-row")).toHaveCount(1)
    await expect(
      page.getByRole("heading", { name: "Calendar / read events", exact: true })
    ).toBeVisible()
    await filter.fill("family dates")
    await expect(page.locator(".settings-access-row")).toHaveCount(1)
    await filter.fill("no matching tool")
    await expect(
      page.getByRole("heading", { name: "No matching tools", exact: true })
    ).toBeVisible()
    await page
      .getByRole("button", { name: "Clear filter", exact: true })
      .press("Enter")
    await expect(filter).toHaveValue("")
    await expect(filter).toBeFocused()
    await expect(page.locator(".settings-access-row")).toHaveCount(3)
    await expect(
      page.getByRole("button", { name: "Browser", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Terminal", exact: true })
    ).toBeVisible()
    const bounds = await page
      .getByRole("heading", { name: "Tool access", exact: true })
      .boundingBox()
    const controls = await filter.boundingBox()
    expect(bounds!.y).toBeLessThan(controls!.y)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth
      )
    ).toBeLessThanOrEqual(1)
  }
  expect(writes).toEqual([])
})
