import assert from "node:assert/strict"
import { spawn, execFile } from "node:child_process"
import { once } from "node:events"
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import { promisify } from "node:util"

import { chromium, expect } from "@playwright/test"

const execute = promisify(execFile)
const project = process.cwd()
const scratch = await mkdtemp(join(tmpdir(), "pi-upgrade-"))
const evidence = resolve(
  process.env.PI_UPGRADE_EVIDENCE_DIR ?? "test-results/client-upgrade"
)
const before = "a".repeat(40),
  after = "b".repeat(40)
const active = join(scratch, "active")
let server, browser
await mkdir(evidence, { recursive: true })

async function buildFixture(name, revision) {
  const output = join(scratch, name)
  await execute(
    process.execPath,
    ["--import", "tsx", "scripts/performance/server.mjs", "--build-only"],
    {
      cwd: project,
      env: { ...process.env, PERF_DIST: output, PERF_BUILD_REVISION: revision },
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  )
  return output
}
async function startFixture() {
  const reservation = createServer()
  reservation.listen(0, "127.0.0.1")
  await once(reservation, "listening")
  const port = reservation.address().port
  await new Promise((done) => reservation.close(done))
  let output = ""
  server = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/performance/server.mjs",
      String(port),
      "--serve-only",
    ],
    {
      cwd: project,
      env: { ...process.env, PERF_DIST: active, PERF_CASE: "journey" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  server.stdout.on("data", (chunk) => {
    output = (output + chunk).slice(-4000)
  })
  server.stderr.on("data", (chunk) => {
    output = (output + chunk).slice(-4000)
  })
  const origin = `http://127.0.0.1:${port}`
  await expect
    .poll(
      async () => {
        assert.equal(server.exitCode, null, output)
        try {
          return (
            await (
              await fetch(`${origin}/api/version`, {
                signal: AbortSignal.timeout(1000),
              })
            ).json()
          ).revision
        } catch {
          return null
        }
      },
      { timeout: 15_000 }
    )
    .toBe(before)
  return origin
}
async function stopFixture() {
  if (!server || server.exitCode !== null) return
  const exited = once(server, "exit")
  const timer = setTimeout(() => server.kill("SIGKILL"), 3000)
  server.kill("SIGTERM")
  await exited
  clearTimeout(timer)
}
async function driveUpgrade(origin, replacement) {
  browser = await chromium.launch({
    channel: process.env.PI_BROWSER_CHANNEL || undefined,
  })
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  })
  await context.tracing.start({
    screenshots: true,
    snapshots: true,
    sources: true,
  })
  await context.route("**/*", async (route) => {
    if (new URL(route.request().url()).origin !== origin)
      throw new Error("Unexpected external request")
    await route.continue()
  })
  const page = await context.newPage()
  let submissions = 0,
    retiredRequests = 0
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      submissions++
  })
  page.on("response", (response) => {
    if (response.url().includes("/assets/") && response.status() === 404)
      retiredRequests++
  })
  try {
    await page.goto(`${origin}/agents`)
    await expect(
      page.getByRole("heading", { name: "Welcome back.", exact: true })
    ).toBeVisible()
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-smoke@example.invalid")
    await page
      .getByLabel("Password", { exact: true })
      .fill("Disposable browser fixture password 2026!")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    await page
      .getByRole("region", { name: "Your agents" })
      .getByRole("link", { name: /Navi/ })
      .click()
    const composer = page.getByRole("textbox", {
      name: "Message Navi",
      exact: true,
      includeHidden: true,
    })
    await expect(composer).toBeEnabled()
    await composer.fill(
      "Preserve this unsent draft across the real build replacement."
    )
    await page.getByLabel("Choose files", { exact: true }).setInputFiles({
      name: "upgrade-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Original retained attachment."),
    })
    await expect(
      page.getByRole("button", {
        name: "Remove upgrade-note.txt from message",
        exact: true,
      })
    ).toBeVisible()
    const oldEntry = await page
      .locator('script[type="module"][src]')
      .getAttribute("src")
    await page.screenshot({ path: join(evidence, "before.png") })
    // Replace the served build atomically while retaining fixture account/file state.
    const staged = join(scratch, "next")
    await symlink(replacement, staged)
    await rename(staged, active)
    assert.equal(
      (await (await fetch(`${origin}/api/version`)).json()).revision,
      after
    )
    await page
      .getByRole("button", { name: "Agent settings and tools", exact: true })
      .click()
    await page
      .getByRole("menuitem", { name: "Tool access", exact: true })
      .click()
    await expect(
      page.getByText("Pi has been updated", { exact: true })
    ).toBeVisible()
    assert.ok(
      retiredRequests > 0,
      "The old lazy-loaded asset must actually be unavailable"
    )
    await expect(composer).toHaveValue(
      "Preserve this unsent draft across the real build replacement."
    )
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click({ trial: true })
    await page.screenshot({ path: join(evidence, "retired-asset.png") })
    await page.getByRole("button", { name: "Reload page", exact: true }).click()
    await expect(page).toHaveURL(/\/agents\/navi\/settings\/access$/)
    await expect(
      page.getByRole("heading", { name: "Tool access", exact: true })
    ).toBeVisible()
    const newEntry = await page
      .locator('script[type="module"][src]')
      .getAttribute("src")
    assert.notEqual(
      newEntry,
      oldEntry,
      "Reload must fetch the replacement build"
    )
    await page
      .getByRole("button", { name: "Close settings", exact: true })
      .click()
    await expect(composer).toHaveValue(
      "Preserve this unsent draft across the real build replacement."
    )
    await expect(
      page.getByRole("button", {
        name: "Remove upgrade-note.txt from message",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      page.getByText("A new version of Pi is available", { exact: true })
    ).toHaveCount(0)
    assert.equal(submissions, 0)
    await page.screenshot({ path: join(evidence, "after.png") })
    return {
      before,
      after,
      oldEntry,
      newEntry,
      retiredRequests,
      submissions,
      browser: process.env.PI_BROWSER_CHANNEL || "chromium",
    }
  } finally {
    await context.tracing.stop({ path: join(evidence, "trace.zip") })
  }
}
try {
  const first = await buildFixture("before", before)
  const second = await buildFixture("after", after)
  await symlink(first, active)
  const origin = await startFixture()
  const proof = await driveUpgrade(origin, second)
  await writeFile(join(evidence, "result.json"), JSON.stringify(proof, null, 2))
  console.log(
    "Two real frontend builds: retired asset recovery, draft/file preservation, and zero submissions passed."
  )
} finally {
  await browser?.close()
  await stopFixture()
  await rm(scratch, { recursive: true, force: true })
}
await access(join(evidence, "trace.zip"))
await readFile(join(evidence, "result.json"), "utf8")
console.log(
  `Owned server/browser/builds cleaned up; evidence retained at ${evidence}`
)
