import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const fixture = fileURLToPath(
  new URL("./fixtures/workbench-tabs", import.meta.url)
)
const require = createRequire(root + "/package.json")
const { createServer } = await import(require.resolve("vite"))
const server = await createServer({
  configFile: false,
  plugins: [(await import(require.resolve("@tailwindcss/vite"))).default()],
  root: fixture,
  resolve: { alias: [{ find: "@", replacement: root + "/src" }] },
  server: {
    host: "127.0.0.1",
    port: process.argv.includes("--serve") ? 4319 : 0,
    fs: { allow: [root, fixture] },
  },
  esbuild: { jsx: "automatic" },
})
await server.listen()
const port = server.httpServer.address().port
if (process.argv.includes("--serve")) {
  console.log(`Workbench fixture http://127.0.0.1:${port}`)
} else {
  const { chromium, expect } = require("@playwright/test")
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const errors = []
  page.on("pageerror", (error) => errors.push(error.message))
  const by = (name) => page.getByRole("button", { name, exact: true })
  const openTool = async (name) => {
    await by("Open a tool").click()
    await page.getByRole("menuitem").first().waitFor()
    assert.equal(await page.getByRole("menuitem").count(), 9)
    await page.getByRole("menuitem", { name: new RegExp(`^${name}`) }).click()
  }
  try {
    await page.goto(`http://127.0.0.1:${port}`)
    await page.getByRole("tab", { name: "Files", exact: true }).waitFor()
    await page.getByLabel("Draft files").fill("Unsaved file draft")
    assert.deepEqual(
      await page.evaluate(() => Object.keys(window.fixture.mounts)),
      ["files"]
    )
    const original = await page.evaluate(() => {
      window.originalFiles = window.fixture.nodes.files
      return window.fixture.mounts.files
    })
    await openTool("Browser")
    await page
      .getByRole("tab", { name: "Browser", exact: true, selected: true })
      .waitFor()
    assert.equal(
      await page.getByRole("tabpanel", { name: "Files workbench" }).count(),
      0
    )
    assert.equal(await page.locator('[role="tabpanel"][hidden]').count(), 1)
    await openTool("Terminal")
    await page
      .getByRole("tab", { name: "Terminal", exact: true, selected: true })
      .waitFor()
    await page.getByRole("tab", { name: "Browser", exact: true }).click()
    const { default: AxeBuilder } = await import(
      createRequire(root + "/packages/ui/package.json").resolve(
        "@axe-core/playwright"
      )
    )
    const accessibility = await new AxeBuilder({ page })
      .include(".workbench-header")
      .analyze()
    assert.deepEqual(
      accessibility.violations.map((item) => item.id),
      []
    )
    await by("Close Browser tab").click()
    await page
      .getByRole("tab", { name: "Terminal", exact: true, selected: true })
      .waitFor()
    assert.equal(
      await page
        .getByRole("tab", { name: "Terminal", exact: true })
        .evaluate((button) => button === document.activeElement),
      true
    )
    await openTool("Browser")
    await by("Close Browser tab").focus()
    await page.keyboard.press("Enter")
    await page
      .getByRole("tab", { name: "Terminal", exact: true, selected: true })
      .waitFor()
    assert.equal(
      await page
        .getByRole("tab", { name: "Terminal", exact: true })
        .evaluate((button) => button === document.activeElement),
      true
    )
    await page.getByRole("tab", { name: "Files", exact: true }).click()
    assert.equal(
      await page.getByLabel("Draft files").inputValue(),
      "Unsaved file draft"
    )
    assert.equal(
      await page.evaluate(
        () => window.originalFiles === window.fixture.nodes.files
      ),
      true
    )
    assert.equal(
      await page.evaluate(() => window.fixture.mounts.files),
      original
    )
    await by("Expand workbench").click()
    await expect(page.locator(".workbench-host")).toHaveAttribute(
      "data-expanded",
      "true"
    )
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const host = document
            .querySelector(".workbench-host")
            .getBoundingClientRect()
          const sheet = document
            .querySelector(".workbench-sheet")
            .getBoundingClientRect()
          return Math.abs(host.width - sheet.width)
        })
      )
      .toBeLessThan(2)
    await by("Back to conversation").click()
    assert.equal(
      await page.evaluate(
        () => window.originalFiles === window.fixture.nodes.files
      ),
      true
    )
    await page.getByRole("tab", { name: "Files", exact: true }).focus()
    await page.keyboard.press("ArrowRight")
    await page
      .getByRole("tab", { name: "Terminal", exact: true, selected: true })
      .waitFor()
    await page.keyboard.press("Delete")
    await page
      .getByRole("tab", { name: "Files", exact: true, selected: true })
      .waitFor()
    await page.evaluate(() => window.fixture.lock(true))
    assert.equal(await by("Close Files tab").isDisabled(), true)
    assert.equal(await by("Hide workbench").isDisabled(), true)
    assert.equal(await by("Open a tool").isDisabled(), true)
    assert.equal(await by("Expand workbench").isDisabled(), true)
    await page.evaluate(() => window.fixture.lock(false))
    await by("Hide workbench").click()
    await page.waitForFunction(() => window.fixture.closed > 0)
    await page.waitForFunction(
      () => document.activeElement?.textContent === "Show workbench"
    )
    assert.equal(
      await page.evaluate(
        () => window.originalFiles === window.fixture.nodes.files
      ),
      true
    )
    await by("Show workbench").click()
    await page.getByRole("tab", { name: "Files", exact: true }).waitFor()
    assert.equal(
      await page.getByLabel("Draft files").inputValue(),
      "Unsaved file draft"
    )
    const routeCount = await page.evaluate(() => window.fixture.routes.length)
    await by("Close Files tab").click()
    await page.waitForFunction(
      (count) =>
        window.fixture.routes.length > count &&
        window.fixture.routes.at(-1) === null,
      routeCount
    )
    await page.evaluate(() => window.fixture.route("memory"))
    await page
      .getByRole("tab", { name: "Memory", exact: true, selected: true })
      .waitFor()
    await page.setViewportSize({ width: 390, height: 844 })
    await by("Open tabs (1)").waitFor()
    await by("Open tabs (1)").click()
    await page.getByRole("dialog", { name: "Open tabs", exact: true }).waitFor()
    assert.equal(
      await page.locator(".workbench-sheet[data-nested-drawer-open]").count(),
      1
    )
    await page.getByRole("button", { name: "Memory", exact: true }).click()
    await page
      .getByRole("dialog", { name: "Open tabs", exact: true })
      .waitFor({ state: "hidden" })
    await openTool("Code")
    await page.getByLabel("Draft code").waitFor()
    await by("Open tabs (2)").click()
    await page.getByRole("dialog", { name: "Open tabs", exact: true }).waitFor()
    await page.keyboard.press("Escape")
    await page
      .getByRole("dialog", { name: "Open tabs", exact: true })
      .waitFor({ state: "hidden" })
    await page.waitForFunction(
      () =>
        document.activeElement?.getAttribute("aria-label") === "Open tabs (2)"
    )
    await by("Open tabs (2)").click()
    await by("Open another tool").click()
    await page.getByRole("menuitem", { name: "Apps", exact: true }).click()
    await page.getByLabel("Draft apps").waitFor()
    await page.evaluate(() => window.fixture.overlay(true))
    await page
      .getByRole("dialog", { name: "Settings fixture", exact: true })
      .waitFor()
    await page.keyboard.press("Escape")
    await page
      .getByRole("dialog", { name: "Settings fixture", exact: true })
      .waitFor({ state: "hidden" })
    await page.getByLabel("Draft apps").waitFor()
    assert.equal(await page.evaluate(() => window.fixture.mounts.code), 1)
    await page.evaluate(() => window.fixture.unmount())
    await page.waitForFunction(() => window.fixture.unmounts.code === 1)
    assert.deepEqual(errors, [])
    console.log(
      "Workbench desktop/mobile tabs, keyboard, mounted state, locks, overlays and cleanup passed"
    )
  } catch (error) {
    console.log(
      await page.evaluate(() => ({
        text: document.body.innerText,
        routes: window.fixture.routes,
        host: document
          .querySelector(".workbench-host")
          ?.outerHTML.slice(0, 1500),
      }))
    )
    throw error
  } finally {
    await browser.close()
    await server.close()
  }
}
