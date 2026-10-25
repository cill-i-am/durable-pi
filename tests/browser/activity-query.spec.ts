import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import { expect, test, type Page } from "@playwright/test"
import { build } from "vite"

let directory: string, bundle: string
test.beforeAll(async () => {
  test.setTimeout(120_000)
  directory = await mkdtemp(join(tmpdir(), "activity-query-"))
  await build({
    configFile: false,
    root: process.cwd(),
    logLevel: "error",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    resolve: { alias: { "@": resolve("src") } },
    build: {
      outDir: directory,
      emptyOutDir: true,
      lib: {
        entry: resolve("tests/browser/fixtures/activity-query.tsx"),
        name: "ActivityProof",
        formats: ["iife"],
        fileName: () => "proof.js",
      },
      minify: false,
    },
    esbuild: { jsx: "automatic" },
  })
  bundle = await readFile(join(directory, "proof.js"), "utf8")
})
test.afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})
async function mount(page: Page, mode: string) {
  page.on("pageerror", (error) => console.error(error.stack))
  await page.route("**/__activity-proof**", (route) =>
    route.fulfill(
      route.request().url().endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8", body: bundle }
        : {
            contentType: "text/html; charset=utf-8",
            body: '<div id="root"></div><script src="/__activity-proof.js"></script>',
          }
    )
  )
  await page.goto(`/__activity-proof?mode=${mode}`)
}
const proof = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { proof: { calls: string[]; aborted: number } })
        .proof
  )
test("online refresh cannot overlap a held plan observation", async ({
  page,
}) => {
  await mount(page, "plans")
  await expect
    .poll(
      async () =>
        (await proof(page)).calls.filter((path) => path.endsWith("/plans"))
          .length
    )
    .toBe(1)
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(
    (await proof(page)).calls.filter((path) => path.endsWith("/plans"))
  ).toHaveLength(1)
})
test("unmount revokes a held plan observation", async ({ page }) => {
  await mount(page, "plans")
  await expect.poll(async () => (await proof(page)).calls.length).toBe(2)
  await page.getByRole("button", { name: "Unmount query" }).click()
  await expect.poll(async () => (await proof(page)).aborted).toBeGreaterThan(0)
})
test("late run page cannot replace the newly selected run", async ({
  page,
}) => {
  await mount(page, "run")
  await page.getByRole("button", { name: "Earlier records" }).click()
  await expect.poll(async () => (await proof(page)).calls.length).toBe(1)
  await page.getByRole("button", { name: "Switch run" }).click()
  await page.evaluate(() =>
    (window as unknown as { proof: { release: () => void } }).proof.release()
  )
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  await expect(page.getByLabel("Durable run records")).toContainText(
    "new latest"
  )
  await expect(page.getByLabel("Durable run records")).not.toContainText(
    "old older"
  )
})

test("selected plan rejects a schema-valid response for a different identity", async ({
  page,
}) => {
  await mount(page, "identity")
  await expect(page.locator("[data-error]")).toContainText(
    "does not match the selected plan"
  )
  await expect(page.locator("output")).toHaveText("loaded")
  await expect(page.locator("[data-detail]")).toHaveText("none")
})

test("initial plan detail rejects history entries belonging to another plan", async ({
  page,
}) => {
  await mount(page, "initial-history")
  await expect(page.locator("[data-error]")).toContainText(
    "does not match the selected plan"
  )
  await expect(page.locator("output")).toHaveText("loaded")
  await expect(page.locator("[data-detail]")).toHaveText("none")
})

test("plan history pagination cannot import another plan's revisions", async ({
  page,
}) => {
  await mount(page, "history")
  await page
    .getByRole("button", { name: "Revision history", exact: true })
    .click()
  await page
    .getByRole("button", { name: "Earlier revisions", exact: true })
    .click()
  await expect(
    page.getByText("History does not match this plan.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Foreign history marker", { exact: true })
  ).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Earlier revisions", exact: true })
  ).toBeEnabled()
})
