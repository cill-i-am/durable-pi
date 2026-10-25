import { expect, test, type Page } from "@playwright/test"

import { audioBase64 } from "../audio-fixture"

async function openChat(page: Page, deferred = false) {
  await page.addInitScript(
    ({ encoded, deferred }) => {
      let stops = 0
      Object.defineProperty(window, "voiceTrackStops", { get: () => stops })
      const stream = new MediaStream()
      Object.defineProperty(stream, "getTracks", {
        value: () => [
          {
            stop: () => {
              stops++
            },
          },
        ],
      })
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
        value: () =>
          deferred
            ? new Promise((resolve) => {
                Object.defineProperty(window, "releaseVoicePermission", {
                  value: () => resolve(stream),
                })
              })
            : Promise.resolve(stream),
      })
      class Recorder {
        state = "inactive"
        mimeType = "audio/ogg"
        ondataavailable: ((event: { data: Blob }) => void) | null = null
        onstop: (() => void) | null = null
        constructor(readonly stream: MediaStream) {}
        static isTypeSupported(mime: string) {
          return mime.startsWith("audio/ogg")
        }
        start() {
          this.state = "recording"
        }
        stop() {
          this.state = "inactive"
          queueMicrotask(() => {
            this.ondataavailable?.({
              data: new Blob(
                [
                  Uint8Array.from(atob(encoded), (value) =>
                    value.charCodeAt(0)
                  ),
                ],
                { type: this.mimeType }
              ),
            })
            this.onstop?.()
          })
        }
      }
      Object.defineProperty(window, "MediaRecorder", { value: Recorder })
    },
    { encoded: audioBase64, deferred }
  )
  await page.goto("/agents")
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
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
}

test("record a voice note, receive text and retain original playback after reload", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await openChat(page)
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Finish voice message", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Finish voice message", exact: true })
    .click()
  await expect(
    page.getByRole("button", {
      name: "Remove voice-message.ogg from message",
      exact: true,
    })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Message Navi", exact: true })
    .fill("Please answer this voice message.")
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  await expect(page.locator(".assistant-message")).toContainText(
    "Fixture reply received."
  )
  await expect(page.locator(".assistant-message audio")).toHaveCount(0)
  const reply = page.locator(".owner-message")
  await expect(reply.locator("audio")).toHaveCount(1)
  await expect
    .poll(() =>
      reply
        .locator("audio")
        .evaluate((node: HTMLAudioElement) => Number.isFinite(node.duration))
    )
    .toBe(true)
  await reply.locator("audio").evaluate(async (node: HTMLAudioElement) => {
    node.muted = true
    await node.play()
  })
  await reply.getByText("Transcript", { exact: true }).click()
  await expect(
    reply.getByText("Fixture voice request.", { exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(page.locator(".owner-message audio")).toHaveCount(1)
  expect(errors).toEqual([])
})

test("cancelling a pending microphone prompt closes a late stream without uploading", async ({
  page,
}) => {
  let uploads = 0
  page.on("request", (request) => {
    if (request.url().includes("/files/upload")) uploads++
  })
  await openChat(page, true)
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByText("Opening microphone…", { exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Cancel voice recording", exact: true })
    .click()
  await page.evaluate(() =>
    (Reflect.get(window, "releaseVoicePermission") as () => void)()
  )
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "voiceTrackStops")))
    .toBe(1)
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
  expect(uploads).toBe(0)
})

test("an update reload waits until a pending microphone request is cancelled", async ({
  page,
}) => {
  let deployed = false
  await page.route("**/api/version", (route) =>
    route.fulfill({ json: { revision: (deployed ? "b" : "a").repeat(40) } })
  )
  await openChat(page, true)
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  deployed = true
  await page.evaluate(() => window.dispatchEvent(new Event("focus")))
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByText("Finish or cancel the voice recording before reloading.", {
      exact: true,
    })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Cancel voice recording", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeDisabled()
  await page.evaluate(() =>
    (Reflect.get(window, "releaseVoicePermission") as () => void)()
  )
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, "voiceTrackStops")))
    .toBe(1)
  await expect(
    page.getByRole("button", { name: "Reload", exact: true })
  ).toBeEnabled()
})
