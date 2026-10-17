import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { registerHooks } from "node:module"
import { extname, resolve } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"

import { chromium, expect } from "@playwright/test"

import {
  passkeyFixture,
  passkeyOwnerEmail,
  passkeyPassword,
} from "../tests/passkeys-fixture.ts"

// Run real browser WebAuthn ceremonies against the built website and native
// Better Auth/D1 queries. Only unrelated agent/model transports are synthetic.
const screenshots = resolve(".impeccable/review")
await mkdir(screenshots, { recursive: true })
const assets = resolve("dist/client")
let website
const serverErrors = []
const server = createServer((req, res) => {
  void serve(req, res).catch((error) => {
    // Reloading cancels in-flight response streams. pipeline() already tears
    // down the response; writing another status here races Node's headers.
    const cancelled =
      error.code === "ERR_STREAM_PREMATURE_CLOSE" ||
      error.code === "ECONNRESET" ||
      error.name === "AbortError"
    if (!cancelled) serverErrors.push(error.message)
    if (cancelled || res.headersSent || res.destroyed) {
      res.destroy()
      return
    }
    res.writeHead(500)
    res.end("Synthetic passkey server failed")
  })
})
await new Promise((done) => server.listen(0, "localhost", done))
const origin = `http://localhost:${server.address().port}`
const fixture = await passkeyFixture(origin)
Object.assign(globalThis, { __piPasskeyTestEnv: fixture.env })
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers")
      return {
        url:
          "data:text/javascript," +
          encodeURIComponent(
            "export const env=globalThis.__piPasskeyTestEnv; export function waitUntil(work) { void work.catch(() => {}); }"
          ),
        shortCircuit: true,
      }
    return next(specifier, context)
  },
})
website = (await import("../dist/server/server.js")).default
let browser
try {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    serviceWorkers: "block",
  })
  const errors = []
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url())
    if (url.origin !== origin) {
      errors.push("Unexpected external request")
      return route.abort()
    }
    if (url.pathname.startsWith("/api/agent/"))
      return agentFixture(route, url.pathname)
    return route.continue()
  })
  const page = await context.newPage()
  page.on("pageerror", (error) => errors.push(error.message))
  const cdp = await context.newCDPSession(page)
  await cdp.send("WebAuthn.enable")
  const { authenticatorId } = await cdp.send(
    "WebAuthn.addVirtualAuthenticator",
    {
      options: {
        protocol: "ctap2",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
      },
    }
  )
  await page.goto(origin + "/agents/home/settings/security")
  await page.getByLabel("Email", { exact: true }).fill(passkeyOwnerEmail)
  await page.getByLabel("Password", { exact: true }).fill(passkeyPassword)
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  const security = page.getByRole("dialog", {
    name: "Account security",
    exact: true,
  })
  await expect(security).toBeVisible()
  await expect(
    security.getByText("No passkeys yet.", { exact: false })
  ).toBeVisible()
  await security
    .getByRole("button", { name: "Add passkey", exact: true })
    .click()
  await expect(
    security.getByLabel("Passkey name", { exact: true })
  ).toBeFocused()
  await security
    .getByLabel("Passkey name", { exact: true })
    .fill("My browser key")
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "add-passkey.png"),
  })
  await security
    .getByRole("button", { name: "Continue on this device", exact: true })
    .click()
  await expect(
    security.getByText("Passkey added. You can use it next time you sign in.", {
      exact: true,
    })
  ).toBeVisible()
  assert.equal(
    fixture.sql.prepare("SELECT count(*) AS count FROM passkey").get().count,
    1
  )
  await security
    .getByRole("button", { name: "Rename My browser key", exact: true })
    .click()
  await security
    .getByLabel("Passkey name", { exact: true })
    .fill("My laptop key")
  await security.getByRole("button", { name: "Save name", exact: true }).click()
  await expect(
    security.getByRole("button", { name: "Rename My laptop key", exact: true })
  ).toBeFocused()
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "desktop.png"),
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "mobile.png"),
  })
  await page.evaluate(() => document.documentElement.classList.add("dark"))
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "mobile-dark.png"),
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    ),
    true
  )
  const renameColor = await security
    .getByRole("button", { name: "Rename My laptop key", exact: true })
    .evaluate((button) => getComputedStyle(button).color)
  const foreground = await security.evaluate(
    (dialog) => getComputedStyle(dialog).color
  )
  assert.equal(renameColor, foreground)
  await page.setViewportSize({ width: 320, height: 740 })
  assert.equal(
    await security.evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth
    ),
    true
  )
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "mobile-320.png"),
  })
  // A 720×500 CSS viewport rendered at 2× models desktop browser zoom:
  // media queries reflow as they do at 200%, unlike CSS zoom on a 1440 viewport.
  await page.setViewportSize({ width: 720, height: 500 })
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 720,
    height: 500,
    deviceScaleFactor: 2,
    mobile: false,
  })
  await security.evaluate((dialog) => {
    dialog.scrollTop = 0
  })
  assert.equal(await page.evaluate(() => innerWidth), 720)
  assert.equal(
    await security.evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth
    ),
    true
  )
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "zoom-200.png"),
  })
  await cdp.send("Emulation.clearDeviceMetricsOverride")
  await page.setViewportSize({ width: 390, height: 844 })
  await security
    .getByRole("button", { name: "Remove My laptop key", exact: true })
    .click()
  await expect(
    security.getByRole("button", { name: "Cancel", exact: true })
  ).toBeFocused()
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "remove-passkey.png"),
  })
  await security.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(
    security.getByRole("button", { name: "Remove My laptop key", exact: true })
  ).toBeFocused()

  const longName = "K".repeat(100)
  fixture.sql.prepare("UPDATE passkey SET name=?").run(longName)
  await page.setViewportSize({ width: 320, height: 740 })
  await page.reload()
  await security
    .getByRole("button", { name: `Remove ${longName}`, exact: true })
    .click()
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "remove-long-name.png"),
  })
  assert.equal(
    await security
      .getByRole("heading", { name: `Remove “${longName}”?`, exact: true })
      .evaluate((heading) => heading.scrollWidth <= heading.clientWidth),
    true,
    "The full name must remain readable in the removal heading"
  )
  assert.equal(
    await security.evaluate(
      (dialog) => dialog.scrollWidth <= dialog.clientWidth
    ),
    true,
    "A maximum-length passkey name must wrap in removal confirmation"
  )
  const body = security.locator(".responsive-overlay-body")
  assert.equal(
    await body.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    ),
    true
  )
  await page.setViewportSize({ width: 720, height: 500 })
  await security
    .getByRole("heading", { name: `Remove “${longName}”?`, exact: true })
    .scrollIntoViewIfNeeded()
  assert.equal(
    await body.evaluate(
      (element) => element.scrollWidth <= element.clientWidth
    ),
    true
  )
  assert.equal(
    await security
      .getByRole("heading", { name: `Remove “${longName}”?`, exact: true })
      .evaluate((heading) => heading.scrollWidth <= heading.clientWidth),
    true
  )
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "remove-long-name-zoom.png"),
  })
  await security.getByRole("button", { name: "Cancel", exact: true }).click()
  fixture.sql.prepare("UPDATE passkey SET name=?").run("My laptop key")
  await page.setViewportSize({ width: 390, height: 844 })
  await page.reload()

  // Native challenge, origin and device-verification checks, with real signed
  // assertions from the virtual authenticator; no verification functions mocked.
  await signOut(page)
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "signin-mobile.png"),
  })
  await page
    .getByRole("button", { name: "Sign in with a passkey", exact: true })
    .click()
  await expect(security).toBeVisible()
  assert.ok(
    fixture.sql.prepare("SELECT counter FROM passkey").get().counter > 0
  )
  await signOut(page)
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: false,
  })
  const unverified = await assertion(page, "unverified")
  assert.equal(unverified.status, 403)
  assert.equal(unverified.code, "PASSKEY_DEVICE_VERIFICATION_REQUIRED")
  assert.equal(await session(page), null)
  await cdp.send("WebAuthn.setUserVerified", {
    authenticatorId,
    isUserVerified: true,
  })
  const foreign = await assertion(page, "foreign-origin")
  assert.equal(foreign.status, 400)
  assert.equal(await session(page), null)
  const replay = await assertion(page, "replay")
  assert.equal(replay.status, 400)
  assert.equal(replay.code, "CHALLENGE_NOT_FOUND")
  await page.reload()
  await expect(security).toBeVisible()

  await cdp.send("WebAuthn.setResponseOverrideBits", {
    authenticatorId,
    isBadUV: true,
  })
  const before = fixture.sql
    .prepare("SELECT count(*) AS count FROM passkey")
    .get().count
  const rejected = await page.evaluate(async () => {
    const options = await (
      await fetch("/api/auth/passkey/generate-register-options")
    ).json()
    options.excludeCredentials = []
    const credential = await navigator.credentials.create({
      publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options),
    })
    const response = await fetch("/api/auth/passkey/verify-registration", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response: credential.toJSON(),
        name: "Unverified key",
      }),
    })
    return { status: response.status, body: await response.json() }
  })
  assert.equal(rejected.status, 403)
  assert.equal(rejected.body.code, "PASSKEY_DEVICE_VERIFICATION_REQUIRED")
  assert.equal(
    fixture.sql.prepare("SELECT count(*) AS count FROM passkey").get().count,
    before
  )
  await cdp.send("WebAuthn.setResponseOverrideBits", { authenticatorId })

  fixture.sql
    .prepare("UPDATE session SET createdAt=? WHERE userId=?")
    .run(Date.now() - 2 * 86_400_000, fixture.owner)
  await security
    .getByRole("button", { name: "Add passkey", exact: true })
    .click()
  await security
    .getByLabel("Passkey name", { exact: true })
    .fill("Aged browser")
  await security
    .getByRole("button", { name: "Continue on this device", exact: true })
    .click()
  await expect(security.getByRole("alert")).toContainText(
    "Sign out and sign in again before adding a passkey."
  )
  await page.screenshot({
    animations: "disabled",
    path: resolve(screenshots, "fresh-sign-in.png"),
  })
  await security.getByRole("button", { name: "Cancel", exact: true }).click()
  await security
    .getByRole("button", { name: "Remove My laptop key", exact: true })
    .click()
  await security
    .getByRole("button", { name: "Remove passkey", exact: true })
    .click()
  await expect(
    security.getByText(
      "Passkey removed. Existing browser sessions stay signed in.",
      { exact: true }
    )
  ).toBeVisible()
  assert.equal(
    fixture.sql.prepare("SELECT count(*) AS count FROM passkey").get().count,
    0
  )
  assert.notEqual(await session(page), null)
  assert.deepEqual(errors, [])
  assert.deepEqual(serverErrors, [])
  console.log(
    "Built website passkeys passed: registration, password-free sign-in, device proof, origin, replay, freshness, rename, removal and private native auth."
  )
} finally {
  await browser?.close()
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  fixture.sql.close()
  delete globalThis.__piPasskeyTestEnv
}

async function signOut(page) {
  await page.evaluate(() =>
    fetch("/api/auth/sign-out", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
  )
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Sign in with a passkey", exact: true })
  ).toBeEnabled()
}
async function session(page) {
  return page.evaluate(async () =>
    (await fetch("/api/auth/get-session")).json()
  )
}
async function assertion(page, mode) {
  return page.evaluate(async (test) => {
    const options = await (
      await fetch("/api/auth/passkey/generate-authenticate-options")
    ).json()
    options.userVerification =
      test === "unverified" ? "discouraged" : "required"
    const credential = await navigator.credentials.get({
      publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(options),
    })
    const body = credential.toJSON()
    if (test === "foreign-origin") {
      const data = JSON.parse(
        atob(
          body.response.clientDataJSON.replaceAll("-", "+").replaceAll("_", "/")
        )
      )
      data.origin = "https://foreign.invalid"
      body.response.clientDataJSON = btoa(JSON.stringify(data))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "")
    }
    const send = () =>
      fetch("/api/auth/passkey/verify-authentication", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ response: body }),
      })
    let response = await send()
    if (test === "replay") {
      if (!response.ok) throw new Error("Initial assertion did not verify")
      response = await send()
    }
    const result = await response.json()
    return { status: response.status, code: result.code }
  }, mode)
}
async function agentFixture(route, path) {
  const profile = {
    id: "home",
    name: "Navi",
    instructions: "Synthetic passkey fixture",
    status: "active",
    revision: 1,
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
  }
  if (path === "/api/agent/bots")
    return route.fulfill({ json: { agents: [profile] } })
  if (path === "/api/agent/bots/statuses")
    return route.fulfill({
      json: { statuses: [{ agentId: "home", state: "ready", turnId: null }] },
    })
  if (path === "/api/agent/files") return route.fulfill({ json: { files: [] } })
  if (path === "/api/agent/objects")
    return route.fulfill({ json: { objects: [] } })
  if (path === "/api/agent/models")
    return route.fulfill({
      json: {
        models: [],
        checkedAt: null,
        error: "Synthetic model transport",
        usage: "ChatGPT plan usage",
        selection: { model: "test", thinking: "medium", settingsRevision: 0 },
        assignments: {},
      },
    })
  if (path === "/api/agent/events")
    return route.fulfill({
      contentType: "text/event-stream",
      body: 'data: {"type":"MESSAGES_SNAPSHOT","messages":[]}\n\ndata: {"type":"CUSTOM","name":"durable-pi.metadata","value":{"model":"test","connected":false,"memory":{"messages":0,"summaries":0,"ready":true,"notes":[]}}}\n\n',
    })
  return route.fulfill({
    status: 503,
    json: { error: "Unrelated agent transport is synthetic" },
  })
}
async function serve(req, res) {
  const url = new URL(req.url, origin)
  const file = resolve(assets, "." + decodeURIComponent(url.pathname))
  if (url.pathname.startsWith("/assets/") && file.startsWith(assets + "/")) {
    const bytes = await readFile(file)
    res.writeHead(200, {
      "content-type":
        {
          ".js": "text/javascript",
          ".css": "text/css",
          ".woff2": "font/woff2",
        }[extname(file)] ?? "application/octet-stream",
    })
    res.end(bytes)
    return
  }
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers))
    if (value !== undefined)
      headers.set(name, Array.isArray(value) ? value.join(",") : value)
  headers.set("x-forwarded-for", "192.0.2.5")
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 65_536) throw new Error("Synthetic auth body too large")
    chunks.push(chunk)
  }
  const response = await website.fetch(
    new Request(url, {
      method: req.method,
      headers,
      body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
    })
  )
  const outgoing = Object.fromEntries(
    [...response.headers].filter(([name]) => name !== "set-cookie")
  )
  if (response.headers.getSetCookie().length)
    outgoing["set-cookie"] = response.headers.getSetCookie()
  res.writeHead(response.status, outgoing)
  if (response.body) await pipeline(Readable.fromWeb(response.body), res)
  else res.end()
}
