import { expect, test, type Page } from "@playwright/test"

type SoundProbe = {
  contexts: number
  oscillators: number
  resumes: number
  ended: number
  disconnected: number
  closing: number
  closed: number
  gestures: boolean[]
}

declare global {
  interface Window {
    interactionSoundProbe: SoundProbe
    interactionSoundContexts: AudioContext[]
  }
}

async function observeNativeSound(page: Page) {
  await page.addInitScript(() => {
    const probe: SoundProbe = {
      contexts: 0,
      oscillators: 0,
      resumes: 0,
      ended: 0,
      disconnected: 0,
      closing: 0,
      closed: 0,
      gestures: [],
    }
    window.interactionSoundProbe = probe
    window.interactionSoundContexts = []
    const Audio = window.AudioContext
    window.AudioContext = class extends Audio {
      constructor() {
        super()
        probe.contexts++
        window.interactionSoundContexts.push(this)
        probe.gestures.push(navigator.userActivation.isActive)
      }
      override createOscillator() {
        const oscillator = super.createOscillator()
        probe.oscillators++
        oscillator.addEventListener(
          "ended",
          () => {
            probe.ended++
          },
          { once: true }
        )
        const disconnect = oscillator.disconnect.bind(oscillator)
        Object.defineProperty(oscillator, "disconnect", {
          value: () => {
            probe.disconnected++
            disconnect()
          },
        })
        return oscillator
      }
      override resume() {
        probe.resumes++
        probe.gestures.push(navigator.userActivation.isActive)
        return super.resume()
      }
      override async close() {
        probe.closing++
        await super.close()
        probe.closed++
      }
    }
  })
}

test("native pointer and keyboard sound preserve gesture, mute, preview and context cleanup", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await observeNativeSound(page)
  await page.goto("/agents")
  const password = page.getByLabel("Password", { exact: true })
  await expect(
    page.getByRole("button", { name: "Show password", exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => window.interactionSoundProbe.contexts)).toBe(
    0
  )
  await page.getByRole("button", { name: "Show password", exact: true }).click()
  await expect(password).toHaveAttribute("type", "text")
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.disconnected))
    .toBe(1)
  expect(
    await page.evaluate(async () => {
      const audio = window.interactionSoundContexts[0]!
      await audio.suspend()
      return audio.state
    })
  ).toBe("suspended")
  await page.getByRole("button", { name: "Hide password", exact: true }).focus()
  await page.keyboard.press("Enter")
  await expect(password).toHaveAttribute("type", "password")
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.disconnected))
    .toBe(2)
  expect(
    await page.evaluate(() => window.interactionSoundProbe.resumes)
  ).toBeGreaterThan(0)
  expect(
    await page.evaluate(() =>
      window.interactionSoundProbe.gestures.every(Boolean)
    )
  ).toBe(true)
  await page
    .getByRole("button", { name: "Mute interaction sounds", exact: true })
    .click()
  await page.getByRole("button", { name: "Show password", exact: true }).click()
  await expect(password).toHaveAttribute("type", "text")
  expect(
    await page.evaluate(() => window.interactionSoundProbe.oscillators)
  ).toBe(2)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await password.fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.closed))
    .toBe(1)
  await page.goto("/agents/home/settings/general")
  await expect(
    page.getByRole("switch", { name: "Interaction sounds", exact: true })
  ).not.toBeChecked()
  await page.getByRole("button", { name: "Test sound", exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.disconnected))
    .toBe(1)
  expect(
    await page.evaluate(() => window.interactionSoundProbe.oscillators)
  ).toBe(1)
  expect(errors).toEqual([])
})

test("blocked audio and failed preference writes never block password visibility", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    window.interactionSoundProbe = {
      contexts: 0,
      oscillators: 0,
      resumes: 0,
      ended: 0,
      disconnected: 0,
      closing: 0,
      closed: 0,
      gestures: [],
    }
    Object.defineProperty(window, "AudioContext", {
      value: class {
        constructor() {
          window.interactionSoundProbe.contexts++
          throw new Error("Audio unavailable")
        }
      },
    })
    Storage.prototype.setItem = () => {
      throw new Error("Storage unavailable")
    }
  })
  await page.goto("/agents")
  const password = page.getByLabel("Password", { exact: true })
  await page.getByRole("button", { name: "Show password", exact: true }).click()
  await expect(password).toHaveAttribute("type", "text")
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.contexts))
    .toBe(1)
  await page.getByRole("button", { name: "Hide password", exact: true }).click()
  await expect(password).toHaveAttribute("type", "password")
  await expect
    .poll(() => page.evaluate(() => window.interactionSoundProbe.contexts))
    .toBe(2)
  await page
    .getByRole("button", { name: "Mute interaction sounds", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Enable interaction sounds", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Show password", exact: true }).click()
  await expect(password).toHaveAttribute("type", "text")
  expect(await page.evaluate(() => window.interactionSoundProbe.contexts)).toBe(
    2
  )
  expect(errors).toEqual([])
})
