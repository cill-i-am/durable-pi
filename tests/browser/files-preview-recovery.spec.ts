import { expect, test } from "@playwright/test"

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

test("a failed file preview retries its read without changing the file", async ({
  page,
}) => {
  const reads: string[] = []
  const writes: string[] = []
  await page.route("**/api/agent/files**", async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    if (request.method() !== "GET") {
      writes.push(url.pathname)
      await route.abort()
      return
    }
    if (url.pathname.endsWith(`/${id}/text`)) {
      reads.push(url.pathname)
      if (reads.length === 1) {
        await route.abort("failed")
        return
      }
      await route.fulfill({
        json: { text: "# Saturday walk\n\nMeet at 10:30.", next: null },
      })
      return
    }
    await route.fulfill({
      json: {
        files: [
          {
            id,
            name: "Walk itinerary.md",
            mime: "text/markdown",
            kind: "text",
            size: 2400,
            createdAt: "2026-10-31T08:14:00Z",
            status: "ready",
            trashed: false,
          },
        ],
      },
    })
  })
  await page.goto(`/agents/navi/files/${id}`)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("region", { name: "Details for Walk itinerary.md" })
  ).toBeVisible()
  await expect(
    page.getByText("Could not open this preview.", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Retry preview", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Saturday walk", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("tab", { name: "Preview", exact: true })
  ).toBeVisible()
  expect(reads).toEqual([
    `/api/agent/files/${id}/text`,
    `/api/agent/files/${id}/text`,
  ])
  expect(writes).toEqual([])
})
