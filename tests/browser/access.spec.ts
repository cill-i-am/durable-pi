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
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
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
