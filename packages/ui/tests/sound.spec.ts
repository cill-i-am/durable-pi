import { expect, test, type Page, type TestInfo } from "@playwright/test"

type AudioMetrics = {
  created: number
  resumed: number
  started: number
  stopped: number
  disconnected: number
  closing: number
  closed: number
  activeGesture: boolean[]
  frequencies: number[]
  gains: number[]
}
type AudioWindow = Window & {
  __soundMetrics: AudioMetrics
  __releaseSoundClose: () => void
  __STORYBOOK_ADDONS_CHANNEL__: { emit: (name: string, value: unknown) => void }
}

/** All browser tests stay physically silent. These stubs exercise the real
 * machine, component and WebAudio capability pipeline, not listening quality. */
async function stubAudio(
  page: Page,
  mode: "normal" | "blocked" | "held" | "unsupported" = "normal"
) {
  await page.addInitScript((audioMode) => {
    const target = window as unknown as AudioWindow
    const metrics: AudioMetrics = {
      created: 0,
      resumed: 0,
      started: 0,
      stopped: 0,
      disconnected: 0,
      closing: 0,
      closed: 0,
      activeGesture: [],
      frequencies: [],
      gains: [],
    }
    target.__soundMetrics = metrics
    class AudioStub {
      state = "suspended"
      currentTime = 0
      destination = {}
      constructor() {
        metrics.created++
        metrics.activeGesture.push(navigator.userActivation.isActive)
      }
      resume() {
        metrics.resumed++
        if (audioMode === "blocked")
          return Promise.reject(new DOMException("Blocked", "NotAllowedError"))
        this.state = "running"
        return Promise.resolve()
      }
      close() {
        metrics.closing++
        const finish = () => {
          this.state = "closed"
          metrics.closed++
        }
        if (audioMode !== "held") {
          finish()
          return Promise.resolve()
        }
        return new Promise<void>((resolve) => {
          target.__releaseSoundClose = () => {
            finish()
            resolve()
          }
        })
      }
      createOscillator() {
        return {
          type: "sine",
          frequency: {
            setValueAtTime: (value: number) => metrics.frequencies.push(value),
          },
          connect: () => {},
          start: () => {
            metrics.started++
          },
          stop: () => {
            metrics.stopped++
          },
          disconnect: () => {
            metrics.disconnected++
          },
        }
      }
      createGain() {
        return {
          gain: {
            setValueAtTime: (value: number) => metrics.gains.push(value),
            linearRampToValueAtTime: (value: number) =>
              metrics.gains.push(value),
            exponentialRampToValueAtTime: (value: number) =>
              metrics.gains.push(value),
            cancelScheduledValues: () => {},
          },
          connect: () => {},
          disconnect: () => {
            metrics.disconnected++
          },
        }
      }
    }
    Object.defineProperty(window, "AudioContext", {
      configurable: true,
      value: audioMode === "unsupported" ? undefined : AudioStub,
    })
  }, mode)
}
async function openAudition(page: Page, info: TestInfo) {
  const theme = info.project.metadata.theme === "dark" ? "dark" : "light"
  await page.goto(
    `/iframe.html?id=foundations-sound--audition&viewMode=story&globals=theme:${theme}`
  )
  await expect(
    page.getByRole("heading", { name: "Sound audition", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Enable sound", exact: true })
  ).toBeEnabled()
}
const metrics = (page: Page) =>
  page.evaluate(() => (window as unknown as AudioWindow).__soundMetrics)
async function hide(page: Page, hidden: boolean) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, value })
    document.dispatchEvent(new Event("visibilitychange"))
  }, hidden)
}

test.describe("sound audition", () => {
  test("load and Enable stay silent; deliberate cue clicks synthesize bounded cues and close resources", async ({
    page,
  }, info) => {
    await stubAudio(page)
    await openAudition(page, info)
    await expect(
      page.getByRole("button", { name: "Play Complete", exact: true })
    ).toBeDisabled()
    expect((await metrics(page)).created).toBe(0)
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click()
    expect((await metrics(page)).created).toBe(0)
    await page
      .getByRole("button", { name: "Play Complete", exact: true })
      .click()
    await expect.poll(async () => (await metrics(page)).closed).toBe(1)
    await expect(
      page.getByRole("button", { name: "Play Attention", exact: true })
    ).toBeDisabled()
    await expect(page.getByRole("status")).toContainText("Wait two seconds")
    const first = await metrics(page)
    expect(first).toMatchObject({
      created: 1,
      resumed: 1,
      started: 2,
      disconnected: 4,
      activeGesture: [true],
      frequencies: [660, 880],
    })
    expect(Math.max(...first.gains)).toBeLessThanOrEqual(0.025)
    await expect(
      page.getByRole("button", { name: "Play Attention", exact: true })
    ).toBeEnabled()
    await page
      .getByRole("button", { name: "Play Attention", exact: true })
      .click()
    await expect.poll(async () => (await metrics(page)).closed).toBe(2)
    expect((await metrics(page)).frequencies).toEqual([660, 880, 440, 349.23])
    await page.getByRole("button", { name: "Mute sound", exact: true }).click()
    await expect(
      page.getByRole("button", { name: "Enable sound", exact: true })
    ).toBeVisible()
    await expect(page.getByRole("status")).toContainText("Muted")
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
  })

  test("mute and held close prevent new work until cleanup and cooldown finish", async ({
    page,
  }, info) => {
    await stubAudio(page, "held")
    await openAudition(page, info)
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Play Complete", exact: true })
      .click()
    await expect.poll(async () => (await metrics(page)).started).toBe(2)
    await page.getByRole("button", { name: "Mute sound", exact: true }).click()
    await expect.poll(async () => (await metrics(page)).closing).toBe(1)
    await expect(
      page.getByRole("button", { name: "Enable sound", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Play Complete", exact: true })
    ).toBeDisabled()
    expect((await metrics(page)).closed).toBe(0)
    await page.evaluate(() =>
      (window as unknown as AudioWindow).__releaseSoundClose()
    )
    await expect(
      page.getByRole("button", { name: "Enable sound", exact: true })
    ).toBeEnabled()
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Play Complete", exact: true })
    ).toBeDisabled()
    await expect(
      page.getByRole("button", { name: "Play Complete", exact: true })
    ).toBeEnabled()
    expect((await metrics(page)).created).toBe(1)
  })

  test("hiding cancels audio, clears consent, and never catches up on visibility", async ({
    page,
  }, info) => {
    await stubAudio(page)
    await openAudition(page, info)
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Play Attention", exact: true })
      .click()
    await expect.poll(async () => (await metrics(page)).started).toBe(2)
    await hide(page, true)
    await expect.poll(async () => (await metrics(page)).closed).toBe(1)
    await hide(page, false)
    await expect(
      page.getByRole("button", { name: "Enable sound", exact: true })
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Play Attention", exact: true })
    ).toBeDisabled()
    expect((await metrics(page)).created).toBe(1)
  })

  test("story remount joins native close; replacement starts muted", async ({
    page,
  }, info) => {
    await stubAudio(page, "held")
    await openAudition(page, info)
    await page
      .getByRole("button", { name: "Enable sound", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Play Complete", exact: true })
      .click()
    await expect.poll(async () => (await metrics(page)).started).toBe(2)
    await page.evaluate(() =>
      (window as unknown as AudioWindow).__STORYBOOK_ADDONS_CHANNEL__.emit(
        "forceRemount",
        { storyId: "foundations-sound--audition" }
      )
    )
    await expect.poll(async () => (await metrics(page)).closing).toBe(1)
    expect((await metrics(page)).closed).toBe(0)
    await page.evaluate(() =>
      (window as unknown as AudioWindow).__releaseSoundClose()
    )
    await expect.poll(async () => (await metrics(page)).closed).toBe(1)
    await expect(
      page.getByRole("button", { name: "Enable sound", exact: true })
    ).toBeEnabled()
    await expect(
      page.getByRole("button", { name: "Play Complete", exact: true })
    ).toBeDisabled()
    expect((await metrics(page)).created).toBe(1)
  })

  for (const mode of ["blocked", "unsupported"] as const)
    test(`${mode} browser audio reports a truthful silent fallback`, async ({
      page,
    }, info) => {
      await stubAudio(page, mode)
      await openAudition(page, info)
      await page
        .getByRole("button", { name: "Enable sound", exact: true })
        .click()
      const play = page.getByRole("button", {
        name: "Play Complete",
        exact: true,
      })
      await expect(play).toBeEnabled()
      await play.focus()
      await page.keyboard.press("Enter")
      await expect(page.getByRole("status")).toContainText(
        mode === "blocked" ? "Audio was blocked" : "Web Audio is unavailable"
      )
      await expect(
        page.getByRole("button", { name: "Enable sound", exact: true })
      ).toBeEnabled()
      await expect(play).toBeFocused()
      await expect(play).toBeDisabled()
      expect((await metrics(page)).started).toBe(0)
      if (mode === "blocked") expect((await metrics(page)).closed).toBe(1)
    })

  test("keyboard focus survives playback, cooldown and held mute cleanup", async ({
    page,
  }, info) => {
    await stubAudio(page, "held")
    await openAudition(page, info)
    const enable = page.getByRole("button", {
      name: "Enable sound",
      exact: true,
    })
    const complete = page.getByRole("button", {
      name: "Play Complete",
      exact: true,
    })
    await enable.focus()
    await page.keyboard.press("Enter")
    await expect(complete).toBeEnabled()
    await complete.focus()
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await metrics(page)).started).toBe(2)
    await expect(complete).toBeFocused()
    await expect(complete).toBeDisabled()
    await page.keyboard.press("Enter")
    expect((await metrics(page)).created).toBe(1)
    await expect.poll(async () => (await metrics(page)).closing).toBe(1)
    await expect(complete).toBeFocused()
    await page.evaluate(() =>
      (window as unknown as AudioWindow).__releaseSoundClose()
    )
    await expect(page.getByRole("status")).toContainText("Wait two seconds")
    await expect(complete).toBeFocused()
    await page.keyboard.press("Enter")
    expect((await metrics(page)).created).toBe(1)
    await expect(complete).toBeEnabled()
    await expect(complete).toBeFocused()

    const attention = page.getByRole("button", {
      name: "Play Attention",
      exact: true,
    })
    await attention.focus()
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await metrics(page)).started).toBe(4)
    const mute = page.getByRole("button", { name: "Mute sound", exact: true })
    await mute.focus()
    await page.keyboard.press("Enter")
    await expect.poll(async () => (await metrics(page)).closing).toBe(2)
    await expect(enable).toBeFocused()
    await expect(enable).toBeDisabled()
    await page.keyboard.press("Enter")
    expect((await metrics(page)).created).toBe(2)
    await page.evaluate(() =>
      (window as unknown as AudioWindow).__releaseSoundClose()
    )
    await expect(enable).toBeEnabled()
    await expect(enable).toBeFocused()
    expect((await metrics(page)).closed).toBe(2)
  })
})
