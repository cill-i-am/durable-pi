import { expect, test, type Page } from "@playwright/test"

import type { CodeRun, RunInput } from "../../src/execution/contracts"

async function openCode(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await page.goto("/agents/navi/code")
  await expect(
    page.getByRole("button", { name: "Run code", exact: true })
  ).toBeEnabled()
}
function saved(input: RunInput, status: CodeRun["status"]): CodeRun {
  return {
    id: input.id,
    label: input.code,
    status,
    input: { code: input.code, data: input.data },
    createdAt: 1,
    finishedAt: status === "running" ? null : 2,
    output:
      status === "succeeded" ? { result: "6", logs: "", error: null } : null,
  }
}

test("uncertain code retry preserves the saved request and never replays an interrupted result", async ({
  page,
}) => {
  const inputs: RunInput[] = []
  let run: CodeRun | null = null
  let reads = 0
  await page.route("**/api/agent/execution**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST") {
      inputs.push(route.request().postDataJSON())
      if (inputs.length === 1) {
        await route.abort("failed")
        return
      }
      run = saved(inputs[inputs.length - 1]!, "interrupted")
      await route.fulfill({ json: run })
      return
    }
    reads++
    await route.fulfill({
      json: path === "/api/agent/execution" ? { runs: run ? [run] : [] } : run,
    })
  })
  await openCode(page)
  await page.getByRole("button", { name: "Run code", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Retry same request", exact: true })
  ).toBeEnabled()
  await expect(page.getByLabel("JavaScript", { exact: true })).toBeDisabled()
  await expect(
    page.getByText("The outcome is not confirmed.", { exact: false })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Retry same request", exact: true })
    .click()
  await expect(
    page.getByText("This run was interrupted.", { exact: false })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Run code", exact: true })
  ).toBeEnabled()
  const prior = reads
  await expect.poll(() => reads).toBeGreaterThan(prior)
  expect(inputs).toHaveLength(2)
  expect(inputs[1]).toEqual(inputs[0])
})

test("cancelling an unconfirmed code request uses its original run identity", async ({
  page,
}) => {
  let input: RunInput | undefined
  let run: CodeRun | null = null
  const cancels: string[] = []
  await page.route("**/api/agent/execution**", async (route) => {
    const path = new URL(route.request().url()).pathname
    if (route.request().method() === "POST") {
      if (path.endsWith("/run")) {
        input = route.request().postDataJSON()
        await route.abort("failed")
        return
      }
      expect(route.request().postDataJSON()).toEqual({})
      cancels.push(path)
      run = saved(input!, "cancelled")
      await route.fulfill({ json: run })
      return
    }
    await route.fulfill({
      json: path === "/api/agent/execution" ? { runs: run ? [run] : [] } : run,
    })
  })
  await openCode(page)
  await page.getByRole("button", { name: "Run code", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Cancel request", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Cancel request", exact: true })
    .click()
  await expect(page.getByText("Run cancelled.", { exact: false })).toBeVisible()
  await expect(page.getByLabel("JavaScript", { exact: true })).toBeEnabled()
  expect(cancels).toEqual([`/api/agent/execution/${input!.id}/cancel`])
})
