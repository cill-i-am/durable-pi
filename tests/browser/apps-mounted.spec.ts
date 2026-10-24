import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"

import { expect, test, type Page } from "@playwright/test"
import { build } from "vite"

let directory: string, bundle: string
test.beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "apps-mounted-"))
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
        entry: resolve("tests/browser/fixtures/apps-lifecycle.tsx"),
        name: "AppsProof",
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
  await page.route("**/__apps-proof**", (route) =>
    route.fulfill(
      route.request().url().endsWith(".js")
        ? { contentType: "text/javascript; charset=utf-8", body: bundle }
        : {
            contentType: "text/html; charset=utf-8",
            body: '<meta charset="utf-8"><div id="root"></div><script src="/__apps-proof.js"></script>',
          }
    )
  )
  await page.goto(`/__apps-proof?mode=${mode}`)
}
const release = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { proof: { release: () => void } }).proof.release()
  )
test("held app mutation cannot overwrite the next mounted agent", async ({
  page,
}) => {
  await mount(page, "hook")
  await expect(page.locator("output")).toHaveText("one")
  await page.getByRole("button", { name: "Save app", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { proof: { calls: { body: unknown }[] } }
          ).proof.calls.filter((call) => call.body !== null).length
      )
    )
    .toBe(1)
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await release(page)
  await expect(page.locator("output")).toHaveText("two")
  const calls = await page.evaluate(
    () =>
      (
        window as unknown as {
          proof: { calls: { agent: string; body: unknown }[] }
        }
      ).proof.calls
  )
  expect(
    calls.filter((call) => call.agent === "one" && call.body === null)
  ).toHaveLength(1)
})
test("removed iframe action cannot start a follow-up render", async ({
  page,
}) => {
  await mount(page, "frame")
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "Save web" })
    .click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { proof: { actions: number } }).proof.actions
      )
    )
    .toBe(1)
  await page.getByRole("button", { name: "Remove frame" }).click()
  await release(page)
  // Let the completed native promise and its React continuations settle.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(
    await page.evaluate(
      () => (window as unknown as { proof: { renders: number } }).proof.renders
    )
  ).toBe(1)
})
test("form acknowledgement preserves a newer mounted draft", async ({
  page,
}) => {
  await mount(page, "form")
  await page.getByLabel("Name", { exact: true }).fill("submitted")
  await page.getByRole("button", { name: "Save form", exact: true }).click()
  await page.getByLabel("Name", { exact: true }).fill("newer draft")
  await release(page)
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue(
    "newer draft"
  )
  await expect(page.getByRole("status")).toHaveCount(0)
})

test("app retry uses the same operation and immutable payload", async ({
  page,
}) => {
  await mount(page, "hook")
  await expect(page.locator("output")).toHaveText("one")
  await page.evaluate(() => {
    ;(window as unknown as { proof: { offline: boolean } }).proof.offline = true
  })
  await page.getByRole("button", { name: "Save app", exact: true }).click()
  await expect(page.locator("[data-error]")).toContainText(
    "synthetic response lost"
  )
  await page.getByRole("button", { name: "Retry change", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { proof: { calls: { body: unknown }[] } }
          ).proof.calls.filter((call) => call.body !== null).length
      )
    )
    .toBe(2)
  await release(page)
  const writes = await page.evaluate(() =>
    (
      window as unknown as { proof: { calls: { body: unknown }[] } }
    ).proof.calls.filter((call) => call.body !== null)
  )
  expect(writes[1]).toEqual(writes[0])
})

test("sandbox frame rejects wrong sources, channels and revoked authority", async ({
  page,
}) => {
  await mount(page, "frame")
  const button = page
    .frameLocator("iframe")
    .getByRole("button", { name: "Save web" })
  await expect(button).toBeEnabled()
  const channel = await page
    .frameLocator("iframe")
    .locator("script[data-channel]")
    .getAttribute("data-channel")
  const message = async (
    origin: string,
    source: "frame" | "window",
    value: string | null
  ) =>
    page.evaluate(
      ({ origin, source, channel }) =>
        window.dispatchEvent(
          new MessageEvent("message", {
            origin,
            source:
              source === "frame"
                ? document.querySelector("iframe")!.contentWindow
                : window,
            data: { channel, type: "action", name: "save", values: {} },
          })
        ),
      { origin, source, channel: value }
    )
  await message("https://wrong.invalid", "frame", channel)
  await message("null", "window", channel)
  await message("null", "frame", "stale-channel")
  await page.getByRole("button", { name: "Toggle disabled" }).click()
  await expect(button).toBeDisabled()
  await message("null", "frame", channel)
  await page.getByRole("button", { name: "Toggle disabled" }).click()
  await expect(button).toBeEnabled()
  expect(
    await page.evaluate(
      () => (window as unknown as { proof: { actions: number } }).proof.actions
    )
  ).toBe(0)
  await button.click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { proof: { actions: number } }).proof.actions
      )
    )
    .toBe(1)
  await release(page)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { proof: { renders: number } }).proof.renders
      )
    )
    .toBe(2)
  await message("null", "frame", channel)
  await page.getByRole("button", { name: "Advance revision" }).click()
  await expect(button).toBeDisabled()
  const current = await page
    .frameLocator("iframe")
    .locator("script[data-channel]")
    .getAttribute("data-channel")
  await message("null", "frame", current)
  expect(
    await page.evaluate(
      () => (window as unknown as { proof: { actions: number } }).proof.actions
    )
  ).toBe(1)
})
