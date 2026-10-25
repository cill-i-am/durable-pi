import { readFileSync } from "node:fs"

import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

const index = JSON.parse(
  readFileSync(
    new URL("../storybook-static/index.json", import.meta.url),
    "utf8"
  )
) as {
  entries: Record<string, { id: string; type: string }>
}
const storyIds = new Set(
  Object.values(index.entries)
    .filter((entry) => entry.type === "story")
    .map((entry) => entry.id)
)
const errors = new WeakMap<Page, string[]>()

test.describe("motion contracts", () => {
  // The package's broad suite defaults to reduce. These focused cases must prove
  // normal motion exists before asserting that preference changes remove it.
  test.use({ reducedMotion: "no-preference" })
  test.beforeEach(({ page }) => {
    const log: string[] = []
    errors.set(page, log)
    page.on("pageerror", (error) => log.push(error.stack ?? error.message))
    page.on("console", (message) => {
      if (message.type() === "error") log.push(message.text())
    })
  })
  test.afterEach(async ({ page }, info) => {
    const log = errors.get(page) ?? []
    if (log.length)
      await info.attach("motion-browser-errors", {
        body: JSON.stringify(log, null, 2),
        contentType: "application/json",
      })
    expect(
      log,
      "Motion must not introduce browser or rendering errors"
    ).toEqual([])
  })

  test("button: rapid press reversal returns to rest; disabled and static controls never move", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-button--motion")
    const button = page.getByRole("button", { name: "Press", exact: true })
    await moveTo(page, button)
    await page.mouse.down()
    const pressed = await sampleVisual(button, 3)
    expect(
      pressed.some((frame) => !frame.identity),
      "Normal press feedback must actually animate"
    ).toBe(true)
    await page.mouse.up()
    await page.mouse.down()
    await frame(page)
    await page.mouse.up()
    await expect.poll(() => button.evaluate(identityTransform)).toBe(true)

    const disabled = page.getByRole("button", { name: "Disabled", exact: true })
    await expect(disabled).toBeDisabled()
    await pressWithoutWaitingForStability(page, disabled)
    expect(
      (await sampleVisual(disabled)).every((value) => value.identity)
    ).toBe(true)

    const stationary = page.getByRole("button", { name: "Static", exact: true })
    await moveTo(page, stationary)
    await page.mouse.down()
    expect(
      (await sampleVisual(stationary)).every((value) => value.identity)
    ).toBe(true)
    await page.mouse.up()
    expect(
      (await sampleVisual(stationary)).every((value) => value.identity)
    ).toBe(true)
  })

  test("checkbox: rapid native reversals settle the SDK's checked state and indicator", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-checkbox--default")
    const checkbox = page.getByRole("checkbox", { name: "Allow notifications" })
    await rapidClicks(page, checkbox, 3)
    await expect(checkbox).toBeChecked()
    const indicator = checkbox.locator('[data-slot="checkbox-indicator"]')
    await expect(indicator).toHaveCSS("opacity", "1")
    await rapidClicks(page, checkbox, 1)
    await expect(checkbox).not.toBeChecked()
    await expect
      .poll(async () =>
        (await indicator.count())
          ? indicator.evaluate((node) => Number(getComputedStyle(node).opacity))
          : 0
      )
      .toBe(0)
    await rapidClicks(page, checkbox, 1)
    await expect(checkbox).toBeChecked()
    await expect(indicator).toHaveCSS("opacity", "1")
  })

  for (const direction of ["ltr", "rtl"] as const) {
    test(`switch: ${direction} reversal keeps the animated thumb inside its track`, async ({
      page,
    }, info) => {
      await openStory(page, info, "components-switch--off", { direction })
      const track = page.getByRole("switch", { name: "Activity animations" })
      const samples = track.evaluate(async (node) => {
        const positions: {
          left: number
          right: number
          top: number
          bottom: number
        }[] = []
        for (let n = 0; n < 20; n++) {
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => resolve())
          )
          const outer = node.getBoundingClientRect()
          const thumb = node
            .querySelector('[data-slot="switch-thumb"]')!
            .getBoundingClientRect()
          positions.push({
            left: thumb.left - outer.left,
            right: outer.right - thumb.right,
            top: thumb.top - outer.top,
            bottom: outer.bottom - thumb.bottom,
          })
        }
        return positions
      })
      await rapidClicks(page, track, 5)
      await expect(track).toBeChecked()
      for (const bounds of await samples) {
        expect(bounds.left).toBeGreaterThanOrEqual(-1)
        expect(bounds.right).toBeGreaterThanOrEqual(-1)
        expect(bounds.top).toBeGreaterThanOrEqual(-1)
        expect(bounds.bottom).toBeGreaterThanOrEqual(-1)
      }
      await expect
        .poll(() => thumbSide(track))
        .toBe(direction === "rtl" ? "left" : "right")
      await rapidClicks(page, track, 1)
      await expect(track).not.toBeChecked()
      await expect
        .poll(() => thumbSide(track))
        .toBe(direction === "rtl" ? "right" : "left")
    })
  }

  test("first mount: a checked switch starts at its checked position without an entrance tween", async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      const target = window as unknown as { __uiFirstFrames?: number[] }
      target.__uiFirstFrames = []
      let remaining = 180
      const collect = () => {
        const track = document.querySelector('[data-slot="switch"]')
        const thumb = track?.querySelector('[data-slot="switch-thumb"]')
        if (track && thumb)
          target.__uiFirstFrames!.push(
            thumb.getBoundingClientRect().left -
              track.getBoundingClientRect().left
          )
        if (target.__uiFirstFrames!.length < 12 && remaining-- > 0)
          requestAnimationFrame(collect)
      }
      requestAnimationFrame(collect)
    })
    await openStory(page, info, "components-switch--default")
    await expect(page.getByRole("switch")).toBeChecked()
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __uiFirstFrames: number[] }).__uiFirstFrames
              .length
        )
      )
      .toBe(12)
    const positions = await page.evaluate(
      () => (window as unknown as { __uiFirstFrames: number[] }).__uiFirstFrames
    )
    expect(
      Math.max(...positions) - Math.min(...positions),
      "Initial checked state must not travel from the unchecked side"
    ).toBeLessThanOrEqual(0.75)
    await expect.poll(() => thumbSide(page.getByRole("switch"))).toBe("right")
  })

  test("toggle groups: single selection motion stays scoped; multiple selection keeps independent highlights", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-togglegroup--motion-isolation")
    const single = page.getByRole("group", {
      name: "Single selection",
      exact: true,
    })
    const independent = page.getByRole("group", {
      name: "Independent selection",
      exact: true,
    })
    const multiple = page.getByRole("group", {
      name: "Multiple selection",
      exact: true,
    })
    const marker = '[data-slot="toggle-group-indicator"]'
    await expect(single.locator(marker)).toHaveCount(1)
    await expect(independent.locator(marker)).toHaveCount(1)
    const independentBefore = await independent.locator(marker).boundingBox()
    const inFlightBounds = Promise.all([
      sampleMarkerBounds(single, marker),
      sampleMarkerBounds(independent, marker),
    ])
    await rapidClicks(
      page,
      single.getByRole("button", { name: "Two", exact: true }),
      1
    )
    await rapidClicks(
      page,
      single.getByRole("button", { name: "Three", exact: true }),
      1
    )
    await expect(
      single.getByRole("button", { name: "Three", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    await expect(single.locator('[aria-pressed="true"]')).toHaveCount(1)
    for (const contained of (await inFlightBounds).flat())
      expect(
        contained,
        "A layout indicator must never interpolate across another group instance"
      ).toBe(true)
    await expect(
      independent.getByRole("button", { name: "One", exact: true })
    ).toHaveAttribute("aria-pressed", "true")
    await expect.poll(async () => markerWithin(single, marker)).toBe(true)
    const independentAfter = await independent.locator(marker).boundingBox()
    expect(independentBefore).not.toBeNull()
    expect(independentAfter).not.toBeNull()
    expect(
      Math.abs(independentAfter!.x - independentBefore!.x)
    ).toBeLessThanOrEqual(1)
    await multiple.getByRole("button", { name: "Two", exact: true }).click()
    await expect(multiple.locator('[aria-pressed="true"]')).toHaveCount(2)
    await expect(multiple.locator(marker)).toHaveCount(0)
    await expect(single.locator(marker)).toHaveCount(1)
    await expect(independent.locator(marker)).toHaveCount(1)
  })

  for (const direction of ["ltr", "rtl"] as const) {
    for (const story of ["motion", "motion-vertical", "wrapped"]) {
      test(`tabs: ${story} ${direction} retargets the highlight without delaying panels or crossing instances`, async ({
        page,
      }, info) => {
        await openStory(page, info, `components-tabs--${story}`, { direction })
        const list = page.getByRole("tablist", {
          name: "Workspace",
          exact: true,
        })
        const independent = page.getByRole("tablist", {
          name: "Independent",
          exact: true,
        })
        await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
        await expect.poll(() => tabIndicatorAligned(independent)).toBe(true)
        const original = await independent
          .locator('[data-slot="tabs-indicator"]')
          .boundingBox()
        const frames = sampleTabs(list, 20)
        await rapidClicks(
          page,
          list.getByRole("tab", { name: "Connections", exact: true }),
          1
        )
        const samples = await frames
        expect(
          samples.some(
            (sample) => sample.selected === "Connections" && sample.distance > 2
          ),
          "The selected highlight must actually travel"
        ).toBe(true)
        expect(
          samples.every(
            (sample) =>
              sample.contained && sample.panelVisible && sample.labelsStill
          )
        ).toBe(true)
        await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
        await rapidClicks(
          page,
          list.getByRole("tab", { name: "Overview", exact: true }),
          1
        )
        await rapidClicks(
          page,
          list.getByRole("tab", { name: "Family activity", exact: true }),
          1
        )
        await rapidClicks(
          page,
          list.getByRole("tab", { name: "Connections", exact: true }),
          1
        )
        await expect(
          list.getByRole("tab", { name: "Connections", exact: true })
        ).toHaveAttribute("aria-selected", "true")
        await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
        expect(
          await independent
            .locator('[data-slot="tabs-indicator"]')
            .boundingBox()
        ).toEqual(original)
        await expect(
          independent.getByRole("tab", { name: "Overview", exact: true })
        ).toHaveAttribute("aria-selected", "true")
        const connections = list.getByRole("tab", {
          name: "Connections",
          exact: true,
        })
        await connections.press("Home")
        await expect(
          list.getByRole("tab", { name: "Overview", exact: true })
        ).toBeFocused()
        await expect(connections).toHaveAttribute("aria-selected", "true")
        await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
        await page.keyboard.press("End")
        const unavailable = list.getByRole("tab", {
          name: "Unavailable",
          exact: true,
        })
        // Base UI exposes disabled tabs to arrow navigation, but never activates them.
        await expect(unavailable).toBeFocused()
        await page.keyboard.press("Enter")
        await expect(unavailable).toBeDisabled()
        await expect(unavailable).toHaveAttribute("aria-selected", "false")
        await expect(connections).toHaveAttribute("aria-selected", "true")
        await page.keyboard.press(
          story === "motion-vertical"
            ? "ArrowUp"
            : direction === "rtl"
              ? "ArrowRight"
              : "ArrowLeft"
        )
        await expect(connections).toBeFocused()
        expect(
          await connections.evaluate((node) => node.matches(":focus-visible"))
        ).toBe(true)
      })
    }
  }

  test("tabs: first paint starts on the selected tab; 200% RTL wrapping remains aligned", async ({
    page,
  }, info) => {
    await page.addInitScript(() => {
      const target = window as unknown as {
        __tabMountFrames: { distance: number; opacity: string; scale: string }[]
      }
      target.__tabMountFrames = []
      let remaining = 300
      const collect = () => {
        const marker = document.querySelector(
          '[data-slot="tabs-indicator"]:not([hidden])'
        )
        if (marker) {
          const selected = marker
            .parentElement!.querySelector('[aria-selected="true"]')!
            .getBoundingClientRect()
          const indicator = marker.getBoundingClientRect(),
            style = getComputedStyle(marker)
          target.__tabMountFrames.push({
            distance: Math.max(
              Math.abs(selected.left - indicator.left),
              Math.abs(selected.top - indicator.top),
              Math.abs(selected.width - indicator.width),
              Math.abs(selected.height - indicator.height)
            ),
            opacity: style.opacity,
            scale: style.scale,
          })
        }
        if (target.__tabMountFrames.length < 12 && remaining-- > 0)
          requestAnimationFrame(collect)
      }
      requestAnimationFrame(collect)
    })
    await openStory(page, info, "components-tabs--wrapped", {
      direction: "rtl",
      scale: 200,
    })
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __tabMountFrames: {
                  distance: number
                  opacity: string
                  scale: string
                }[]
              }
            ).__tabMountFrames.length
        )
      )
      .toBe(12)
    const mounted = await page.evaluate(
      () =>
        (
          window as unknown as {
            __tabMountFrames: {
              distance: number
              opacity: string
              scale: string
            }[]
          }
        ).__tabMountFrames
    )
    // Native geometry is hidden until measured. Later font/text-scale reflow can
    // update its bounds; it must not enter from an origin or a hidden scale.
    expect(mounted[0]!.distance).toBeLessThan(1.5)
    expect(
      mounted.every(
        (sample) => sample.opacity === "1" && sample.scale === "none"
      )
    ).toBe(true)
    const list = page.getByRole("tablist", { name: "Workspace", exact: true })
    await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
    await list.getByRole("tab", { name: "Connections", exact: true }).click()
    await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
    await list.evaluate((node) => {
      const root = node.closest<HTMLElement>('[data-slot="tabs"]')!
      root.style.width = "200px"
    })
    await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1
      )
    ).toBe(true)
  })

  test("tabs: forced colors retain the selected outline after focus leaves", async ({
    page,
  }, info) => {
    await page.emulateMedia({ forcedColors: "active" })
    await openStory(page, info, "components-tabs--motion")
    const selected = page
      .getByRole("tablist", { name: "Workspace", exact: true })
      .getByRole("tab", { name: "Overview", exact: true })
    await selected.focus()
    await page.keyboard.press("Tab")
    await expect(selected).not.toBeFocused()
    await expect(selected).toHaveAttribute("aria-selected", "true")
    await expect(selected).toHaveCSS("outline-style", "solid")
    await expect(selected).toHaveCSS("outline-width", "2px")
  })

  for (const preference of ["system", "toolbar"] as const) {
    test(`tabs: ${preference} reduced motion cancels travel while mounted`, async ({
      page,
    }, info) => {
      await openStory(page, info, "components-tabs--motion")
      const list = page.getByRole("tablist", { name: "Workspace", exact: true })
      const marker = list.locator('[data-slot="tabs-indicator"]')
      await expect.poll(() => tabIndicatorAligned(list)).toBe(true)
      const probe = await armReducedFrames(list, [
        '[data-slot="tabs-indicator"]',
      ])
      await rapidClicks(
        page,
        list.getByRole("tab", { name: "Connections", exact: true }),
        1
      )
      expect(
        await marker.evaluate((node) =>
          node
            .getAnimations()
            .some((animation) => animation.playState === "running")
        )
      ).toBe(true)
      if (preference === "system")
        await page.emulateMedia({ reducedMotion: "reduce" })
      else
        await page.evaluate(async () => {
          const preview = (
            window as unknown as {
              __STORYBOOK_ADDONS_CHANNEL__: {
                emit: (event: string, payload: unknown) => void
              }
            }
          ).__STORYBOOK_ADDONS_CHANNEL__
          preview.emit("updateGlobals", { globals: { motion: "reduced" } })
        })
      const stopped = await reducedFrames(page, probe)
      expect(
        stopped.every(
          (sample) =>
            sample.connected && sample.offset !== null && sample.offset < 1.5
        )
      ).toBe(true)
      await expect(list).toHaveAttribute("data-motion-reduced", "true")
      expect(
        await marker.evaluate(
          (node) => getComputedStyle(node).transitionProperty
        )
      ).toBe("none")
      await rapidClicks(
        page,
        list.getByRole("tab", { name: "Family activity", exact: true }),
        1
      )
      const reduced = await sampleTabs(list, 6)
      expect(
        reduced.every(
          (sample) =>
            sample.distance < 1.5 && sample.panelVisible && sample.labelsStill
        )
      ).toBe(true)
      expect(
        await marker.evaluate((node) =>
          node
            .getAnimations()
            .some((animation) => animation.playState === "running")
        )
      ).toBe(false)
    })
  }

  test("menu: close/reopen during exit retains native selection, then nested Tab restores usable focus", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-dropdownmenu--default")
    const trigger = page.getByRole("button", {
      name: "Note actions",
      exact: true,
    })
    await trigger.click()
    const descriptions = page.getByRole("menuitemcheckbox", {
      name: "Show descriptions",
    })
    await expect(descriptions).toHaveAttribute("aria-checked", "true")
    await descriptions.click()
    await expect(descriptions).toHaveAttribute("aria-checked", "false")
    await page.keyboard.press("Escape")
    await nativeClick(trigger)
    await expect(descriptions).toBeVisible()
    await expect(descriptions).toHaveAttribute("aria-checked", "false")
    await page.getByRole("menuitem", { name: "Theme", exact: true }).click()
    const light = page.getByRole("menuitemradio", {
      name: "Light",
      exact: true,
    })
    await expect(light).toBeVisible()
    await light.focus()
    await page.keyboard.press("Tab")
    await expect(light).not.toBeVisible()
    await usableFocus(page)
  })

  test("select: close/reopen during exit preserves value and native Tab dismissal", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-select--default")
    const trigger = page.getByRole("combobox", { name: "Model", exact: true })
    // The native phone Drawer aria-hides this owned trigger while open. Query
    // its known DOM slot for retained value/projection, never its hidden role.
    const triggerDom = page.locator('[data-slot="select-trigger"]')
    await trigger.click()
    await page.getByRole("option", { name: "GPT-6 Astra", exact: true }).click()
    await expect(trigger).toContainText("GPT-6 Astra")
    await trigger.click()
    await expect(
      page.getByRole("option", { name: "GPT-6 Astra", exact: true })
    ).toBeVisible()
    await page.keyboard.press("Escape")
    await nativeClick(triggerDom)
    await expect(
      page.getByRole("option", { name: "GPT-6 Astra", exact: true })
    ).toBeVisible()
    await expect(triggerDom).toContainText("GPT-6 Astra")
    // Base UI queues initial/list focus after the entry frame. Visibility alone
    // would send Tab before the native owner has made the reopened list usable.
    await expect(
      page.getByRole("option", { name: "GPT-6 Astra", exact: true })
    ).toBeFocused()
    await page.keyboard.press("Tab")
    await expect(
      page.getByRole("option", { name: "GPT-6 Astra", exact: true })
    ).not.toBeVisible()
    await usableFocus(page)
  })

  for (const kind of ["dialog", "sheet"] as const) {
    test(`${kind}: close/reopen during exit preserves the mounted draft and final focus`, async ({
      page,
    }, info) => {
      await openStory(page, info, `components-${kind}--kept-mounted`)
      const trigger = page.getByRole("button", {
        name: `Open ${kind}`,
        exact: true,
      })
      await trigger.click()
      const dialog = page.getByRole("dialog", {
        name: "Edit profile",
        exact: true,
      })
      const input = dialog.getByRole("textbox", { name: "Name", exact: true })
      await input.fill("Retained motion draft")
      const original = await input.elementHandle()
      await page.keyboard.press("Escape")
      await nativeClick(trigger)
      await expect(dialog).toBeVisible()
      await expect(input).toHaveValue("Retained motion draft")
      expect(
        await input.evaluate((node, previous) => node === previous, original)
      ).toBe(true)
      await expect
        .poll(() => dialog.getAttribute("data-ending-style"))
        .toBeNull()
      await page.keyboard.press("Escape")
      await expect(dialog).not.toBeVisible()
      await expect(trigger).toBeFocused()
    })
  }

  test("live system preference: held press loses scale and blur without replacing the control", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-button--default")
    const button = page.getByRole("button", { name: "Save", exact: true })
    const original = await button.elementHandle()
    await moveTo(page, button)
    await page.mouse.down()
    await expect
      .poll(() => button.evaluate((node) => node.matches(":active")), {
        timeout: 1000,
        message: "The native button must receive the held pointer press",
      })
      .toBe(true)
    await expect
      .poll(
        async () =>
          (await sampleVisual(button, 1)).some((value) => !value.identity),
        {
          timeout: 1000,
          message:
            "Normal held-press feedback must actually animate before the preference change",
        }
      )
      .toBe(true)
    const firstFrames = await armReducedFrames(button)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(button).toHaveAttribute("data-motion-reduced", "true")
    assertImmediateSpatialStop(await reducedFrames(page, firstFrames))
    expect(
      await button.evaluate((node, previous) => node === previous, original)
    ).toBe(true)
    await page.mouse.up()
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expect(button).not.toHaveAttribute("data-motion-reduced", "true")
  })

  test("icon swap: rapid reversal and live OS reduction stop an in-flight blur/scale while retaining state", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-iconswap--rapid-reversal")
    const button = page.getByRole("button", { name: "Shortlist", exact: true })
    const icon = button.locator('[data-slot="icon-swap"]')
    const layer = icon.locator('[data-slot="icon-swap-active"]')
    const original = await icon.elementHandle()
    await rapidClicks(page, button, 3)
    await expect(button).toHaveAttribute("aria-pressed", "true")
    expect(
      (await sampleVisual(layer, 3)).some(
        (value) => value.blurred || !value.identity
      ),
      "The normal icon transition must use real blur/scale interpolation"
    ).toBe(true)
    const firstFrames = await armReducedFrames(icon, [
      '[data-slot="icon-swap-active"]',
      '[data-slot="icon-swap-inactive"]',
    ])
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(icon).toHaveAttribute("data-motion-reduced", "true")
    assertImmediateSpatialStop(await reducedFrames(page, firstFrames, 2))
    await assertIconOpacityConfig(icon)
    await expect(button).toHaveAttribute("aria-pressed", "true")
    expect(
      await icon.evaluate((node, previous) => node === previous, original)
    ).toBe(true)
    await expect(page.getByRole("status")).toHaveText("Shortlisted")
    const inactive = icon.locator('[data-slot="icon-swap-inactive"]')
    await expect(layer).toHaveCSS("opacity", "1")
    await expect(inactive).toHaveCSS("opacity", "0")
    const fade = Promise.all([
      sampleCssOpacity(layer),
      sampleCssOpacity(inactive),
    ])
    await button.click()
    await expect(button).toHaveAttribute("aria-pressed", "false")
    for (const transaction of await fade) {
      expect(
        new Set(transaction.map((sample) => sample.opacity)).size,
        "A reduced icon swap must still perform its real CSS opacity transaction"
      ).toBeGreaterThan(1)
      const transitions = transaction.flatMap((sample) => sample.transitions)
      expect(
        transitions.length,
        "CSS must own the opacity fade"
      ).toBeGreaterThan(0)
      for (const transition of transitions)
        expect(transition).toBeLessThanOrEqual(101)
    }
    await expect(layer).toHaveCSS("opacity", "0")
    await expect(inactive).toHaveCSS("opacity", "1")
    await assertIconOpacityConfig(icon)
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await expect(icon).not.toHaveAttribute("data-motion-reduced", "true")
    await rapidClicks(page, button, 1)
    await expect(button).toHaveAttribute("aria-pressed", "true")
    expect(
      (await sampleVisual(layer, 3)).some(
        (value) => value.blurred || !value.identity
      ),
      "Restoring the OS preference must allow the next normal transition"
    ).toBe(true)
  })

  for (const direction of ["ltr", "rtl"] as const) {
    test(`live system preference: ${direction} moving switch snaps to its native checked endpoint in the first post-flag frame`, async ({
      page,
    }, info) => {
      await openStory(page, info, "components-switch--off", { direction })
      const track = page.getByRole("switch", { name: "Activity animations" })
      const thumb = track.locator('[data-slot="switch-thumb"]')
      const initial = await thumb.evaluate(
        (node) => node.getBoundingClientRect().left
      )
      const original = await thumb.elementHandle()
      await rapidClicks(page, track, 1)
      await expect(track).toBeChecked()
      const before = await sampleThumbOffsets(track, 2)
      expect(
        before.some((value) => Math.abs(value.absoluteLeft - initial) > 0.5),
        "The native checked thumb must actually be moving before reduction"
      ).toBe(true)
      expect(
        Math.abs(before.at(-1)!.offset - before.at(-1)!.endpoint),
        "The preference change must interrupt an unfinished spring"
      ).toBeGreaterThan(0.25)
      const firstFrames = await armReducedFrames(track, [
        '[data-slot="switch-thumb"]',
      ])
      await page.emulateMedia({ reducedMotion: "reduce" })
      await expect(track).toHaveAttribute("data-motion-reduced", "true")
      for (const sample of await reducedFrames(page, firstFrames)) {
        expect(sample.connected, JSON.stringify(sample)).toBe(true)
        expect(sample.blurred, JSON.stringify(sample)).toBe(false)
        expect(
          Math.abs(sample.offset! - sample.endpoint!),
          "No post-flag frame may retain the old thumb spring"
        ).toBeLessThanOrEqual(0.5)
      }
      await expect(track).toBeChecked()
      expect(
        await thumb.evaluate((node, previous) => node === previous, original)
      ).toBe(true)
    })
  }

  test("live system preference: a fading checkbox removes scale and blur in its first six post-flag frames", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-checkbox--checked")
    const checkbox = page.getByRole("checkbox", { name: "Allow notifications" })
    const indicator = checkbox.locator('[data-slot="checkbox-indicator"]')
    const original = await indicator.elementHandle()
    await rapidClicks(page, checkbox, 1)
    await expect(checkbox).not.toBeChecked()
    expect(
      (await sampleVisual(indicator, 2)).some(
        (value) => value.blurred || !value.identity
      ),
      "The checkbox must be spatially interpolating before reduction"
    ).toBe(true)
    const firstFrames = await armReducedFrames(checkbox, [
      '[data-slot="checkbox-indicator"]',
    ])
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(checkbox).toHaveAttribute("data-motion-reduced", "true")
    assertImmediateSpatialStop(await reducedFrames(page, firstFrames))
    await expect(checkbox).not.toBeChecked()
    expect(
      await indicator.evaluate((node, previous) => node === previous, original)
    ).toBe(true)
    await expect(indicator).toHaveCSS("opacity", "0")
  })

  test("live system preference: a moving single-selection marker drops projection transforms immediately", async ({
    page,
  }, info) => {
    await openStory(page, info, "components-togglegroup--motion-isolation")
    const group = page.getByRole("group", {
      name: "Single selection",
      exact: true,
    })
    const choice = group.getByRole("button", { name: "Three", exact: true })
    await rapidClicks(page, choice, 1)
    await expect(choice).toHaveAttribute("aria-pressed", "true")
    const marker = choice.locator('[data-slot="toggle-group-indicator"]')
    expect(
      (await sampleVisual(marker, 2)).some((value) => !value.identity),
      "The selected marker must be in flight before reduction"
    ).toBe(true)
    const firstFrames = await armReducedFrames(choice, [
      '[data-slot="toggle-group-indicator"]',
    ])
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(choice).toHaveAttribute("data-motion-reduced", "true")
    assertImmediateSpatialStop(await reducedFrames(page, firstFrames))
    await expect(choice).toHaveAttribute("aria-pressed", "true")
    await expect(
      group.locator('[data-slot="toggle-group-indicator"]')
    ).toHaveCount(1)
  })

  for (const kind of ["spinner", "skeleton"] as const) {
    test(`${kind}: live OS reduction stops an already running infinite animation and resumes on restore`, async ({
      page,
    }, info) => {
      await openStory(page, info, `components-${kind}--default`)
      const target = page.locator(`[data-slot="${kind}"]`).first()
      const original = await target.elementHandle()
      expect(
        new Set(
          (await sampleVisual(target, 12)).map((value) => value.signature)
        ).size,
        "Normal preference must run the actual loading animation"
      ).toBeGreaterThan(1)
      await page.emulateMedia({ reducedMotion: "reduce" })
      await expect(target).toHaveAttribute("data-motion-reduced", "true")
      await expect.poll(() => infiniteAnimations(target)).toBe(0)
      await expect
        .poll(
          async () =>
            new Set(
              (await sampleVisual(target)).map((value) => value.signature)
            ).size
        )
        .toBe(1)
      expect(
        await target.evaluate((node, previous) => node === previous, original)
      ).toBe(true)
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await expect(target).not.toHaveAttribute("data-motion-reduced", "true")
      await expect
        .poll(
          async () =>
            new Set(
              (await sampleVisual(target)).map((value) => value.signature)
            ).size
        )
        .toBeGreaterThan(1)
    })
  }

  test("toolbar reduction: system no-preference cannot re-enable spinner, skeleton or movement", async ({
    page,
  }, info) => {
    for (const kind of ["spinner", "skeleton"] as const) {
      await openStory(page, info, `components-${kind}--default`, {
        motion: "reduced",
      })
      const target = page.locator(`[data-slot="${kind}"]`).first()
      await expect(target).toHaveAttribute("data-motion-reduced", "true")
      await page.emulateMedia({ reducedMotion: "reduce" })
      await page.emulateMedia({ reducedMotion: "no-preference" })
      await expect(target).toHaveAttribute("data-motion-reduced", "true")
      expect(await infiniteAnimations(target)).toBe(0)
      await expect
        .poll(
          async () =>
            new Set(
              (await sampleVisual(target)).map((value) => value.signature)
            ).size
        )
        .toBe(1)
    }
  })

  test("reduced overlays: native entry and exit use a short opacity fallback without travel, scale or blur", async ({
    page,
  }, info) => {
    for (const kind of ["dialog", "sheet"] as const) {
      await openStory(page, info, `components-${kind}--default`, {
        motion: "reduced",
      })
      await page
        .getByRole("button", { name: `Open ${kind}`, exact: true })
        .click()
      const popup = page.getByRole("dialog", {
        name: "Edit profile",
        exact: true,
      })
      await expect(popup).toHaveAttribute("data-motion-reduced", "true")
      await assertShortOpacityOnly(popup)
      expect(
        (await sampleVisual(popup, 6)).every(
          (value) => value.identity && !value.blurred
        )
      ).toBe(true)
      await page.keyboard.press("Escape")
      await assertShortOpacityOnly(
        page.locator(`[data-slot="${kind}-content"]`)
      )
      await expect(popup).not.toBeVisible()
    }
  })

  test("phone nested drawers: live OS reduction preserves parent geometry, draft identity and focus", async ({
    page,
  }, info) => {
    test.skip(!info.project.use.isMobile, "Native phone stack geometry")
    await openStory(page, info, "compositions-settings--stacked-settings")
    await page
      .getByRole("button", { name: "Open settings", exact: true })
      .click()
    await page.getByRole("button", { name: "Family", exact: true }).click()
    const family = page.getByRole("dialog", { name: "Family", exact: true })
    const familyNode = await family.elementHandle()
    expect(familyNode).not.toBeNull()
    await page
      .getByRole("button", { name: "Model access", exact: true })
      .click()
    const model = page.getByRole("dialog", {
      name: "Model access",
      exact: true,
    })
    const input = model.getByRole("textbox", {
      name: "Connection name",
      exact: true,
    })
    await input.fill("Same draft after OS preference change")
    const original = await input.elementHandle()
    // Native nested drawers intentionally stretch a parent to the frontmost
    // child. Compare the *same* settled stack across only the OS preference flip.
    await stableGeometry(model)
    const parentHeight = await familyNode!.evaluate((node) => node.clientHeight)
    const firstFrames = await armReducedFrames(model)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await expect(model).toHaveAttribute("data-motion-reduced", "true")
    assertImmediateSpatialStop(await reducedFrames(page, firstFrames))
    expect(
      await familyNode!.evaluate((node) => node.clientHeight)
    ).toBeGreaterThan(0)
    expect(
      Math.abs(
        (await familyNode!.evaluate((node) => node.clientHeight)) - parentHeight
      )
    ).toBeLessThanOrEqual(1)
    await model.getByRole("button", { name: "Family", exact: true }).click()
    const reopen = family.getByRole("button", {
      name: "Model access",
      exact: true,
    })
    await expect(reopen).toBeFocused()
    await reopen.click()
    await expect(input).toHaveValue("Same draft after OS preference change")
    expect(
      await input.evaluate((node, previous) => node === previous, original)
    ).toBe(true)
  })

  test("200% text: checked and mixed glyphs and RTL switch thumbs stay inside their frames", async ({
    page,
  }, info) => {
    for (const motion of ["system", "reduced"] as const) {
      for (const state of ["checked", "indeterminate"] as const) {
        await openStory(page, info, `components-checkbox--${state}`, {
          scale: 200,
          motion,
        })
        await expect(page.locator("html")).toHaveCSS("font-size", "32px")
        const checkbox = page.getByRole("checkbox", {
          name: "Allow notifications",
        })
        if (state === "checked") await expect(checkbox).toBeChecked()
        else await expect(checkbox).toHaveAttribute("aria-checked", "mixed")
        const contained = await checkbox.evaluate((node) => {
          const frame = node.getBoundingClientRect()
          return [...node.querySelectorAll("svg")].every((glyph) => {
            const box = glyph.getBoundingClientRect()
            return (
              box.left >= frame.left - 0.5 &&
              box.right <= frame.right + 0.5 &&
              box.top >= frame.top - 0.5 &&
              box.bottom <= frame.bottom + 0.5
            )
          })
        })
        expect(
          contained,
          "Glyphs must remain inside the visible checkbox frame when text grows"
        ).toBe(true)
      }
      for (const direction of ["ltr", "rtl"] as const) {
        await openStory(page, info, "components-switch--off", {
          scale: 200,
          motion,
          direction,
        })
        const track = page.getByRole("switch", { name: "Activity animations" })
        await rapidClicks(page, track, 3)
        await expect(track).toBeChecked()
        await expect
          .poll(() => thumbSide(track))
          .toBe(direction === "rtl" ? "left" : "right")
        expect(
          await track.evaluate((node) => {
            const frame = node.getBoundingClientRect()
            const thumb = node
              .querySelector('[data-slot="switch-thumb"]')!
              .getBoundingClientRect()
            return (
              thumb.left >= frame.left - 0.5 &&
              thumb.right <= frame.right + 0.5 &&
              thumb.top >= frame.top - 0.5 &&
              thumb.bottom <= frame.bottom + 0.5
            )
          }),
          "The enlarged thumb must fit the track in both directions"
        ).toBe(true)
      }
    }
  })

  test("phone native swipe remains the dismissal owner after motion is added", async ({
    page,
  }, info) => {
    test.skip(
      !info.project.use.isMobile,
      "Real Chromium touch input requires the phone project"
    )
    await openStory(page, info, "components-sheet--kept-mounted")
    const trigger = page.getByRole("button", {
      name: "Open sheet",
      exact: true,
    })
    await trigger.click()
    const dialog = page.getByRole("dialog", {
      name: "Edit profile",
      exact: true,
    })
    await dialog
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Swipe keeps this draft")
    await swipeDown(page, dialog.locator(".responsive-overlay-handle"))
    await expect(dialog).not.toBeVisible()
    await expect(trigger).toBeFocused()
    await trigger.click()
    await expect(
      dialog.getByRole("textbox", { name: "Name", exact: true })
    ).toHaveValue("Swipe keeps this draft")
  })
})

async function openStory(
  page: Page,
  info: TestInfo,
  id: string,
  options: {
    direction?: "ltr" | "rtl"
    motion?: "system" | "reduced"
    scale?: 100 | 200
  } = {}
) {
  expect(
    storyIds.has(id),
    `Required motion fixture ${id} is present in the built index`
  ).toBe(true)
  const direction = options.direction ?? "ltr",
    motion = options.motion ?? "system"
  const params = new URLSearchParams({
    id,
    viewMode: "story",
    embed: "true",
    globals: `theme:${info.project.metadata.theme === "dark" ? "dark" : "light"};textScale:${options.scale ?? 100};direction:${direction};motion:${motion}`,
  })
  await page.goto(`/iframe.html?${params}`)
  await page.waitForFunction((storyId) => {
    const current = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          currentRender?: { id?: string; phase?: string }
        }
      }
    ).__STORYBOOK_PREVIEW__?.currentRender
    return current?.id === storyId && current.phase === "finished"
  }, id)
  await expect(page.locator("#storybook-root")).toBeVisible()
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible()
  await expect(page.locator("html")).toHaveAttribute("dir", direction)
  await expect(page.locator("html")).toHaveAttribute("data-ui-motion", motion)
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

// Runs in the preview document. Independent CSS transform properties are checked
// as well as transform so a migrate-to-scale/translate implementation is covered.
function identityTransform(node: Element) {
  const style = getComputedStyle(node)
  const matrix = new DOMMatrixReadOnly(
    style.transform === "none" ? undefined : style.transform
  )
  const scale =
    style.scale === "none" ? [1, 1] : style.scale.split(" ").map(Number)
  const translate =
    style.translate === "none"
      ? [0, 0]
      : style.translate.split(" ").map(Number.parseFloat)
  return (
    Math.abs(matrix.a - 1) < 0.002 &&
    Math.abs(matrix.d - 1) < 0.002 &&
    Math.abs(matrix.b) < 0.002 &&
    Math.abs(matrix.c) < 0.002 &&
    Math.abs(matrix.e) < 0.5 &&
    Math.abs(matrix.f) < 0.5 &&
    scale.every((value) => Math.abs(value - 1) < 0.002) &&
    translate.every((value) => Math.abs(value) < 0.5)
  )
}
async function sampleVisual(locator: Locator, frames = 8) {
  return locator.evaluate(async (node, count) => {
    const samples = []
    for (let n = 0; n < count; n++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      const style = getComputedStyle(node)
      const matrix = new DOMMatrixReadOnly(
        style.transform === "none" ? undefined : style.transform
      )
      const scale =
        style.scale === "none" ? [1, 1] : style.scale.split(" ").map(Number)
      const translate =
        style.translate === "none"
          ? [0, 0]
          : style.translate.split(" ").map(Number.parseFloat)
      samples.push({
        identity:
          Math.abs(matrix.a - 1) < 0.002 &&
          Math.abs(matrix.d - 1) < 0.002 &&
          Math.abs(matrix.e) < 0.5 &&
          Math.abs(matrix.f) < 0.5 &&
          scale.every((value) => Math.abs(value - 1) < 0.002) &&
          translate.every((value) => Math.abs(value) < 0.5),
        blurred:
          style.filter !== "none" && !/^blur\(0(?:px)?\)$/.test(style.filter),
        signature: [
          style.transform,
          style.translate,
          style.scale,
          style.rotate,
          style.filter,
          style.opacity,
        ].join("|"),
      })
    }
    return samples
  }, frames)
}
type ReducedFrame = {
  frame: number
  target: number
  connected: boolean
  identity: boolean
  blurred: boolean
  offset: number | null
  endpoint: number | null
  transform: string
  filter: string
}
type ReducedProbe = { done: boolean; frames: ReducedFrame[] }
let probeSequence = 0

async function armReducedFrames(
  marker: Locator,
  selectors: readonly (string | null)[] = [null]
) {
  const id = `post-flag-${++probeSequence}`
  await marker.evaluate(
    (node, input) => {
      const probes = window as unknown as {
        __uiReducedProbes?: Record<string, ReducedProbe>
      }
      const probe: ReducedProbe = { done: false, frames: [] }
      ;(probes.__uiReducedProbes ??= {})[input.id] = probe
      const targets = input.selectors.map((selector) =>
        selector === null ? node : node.querySelector(selector)
      )
      if (targets.some((target) => !target))
        throw new Error(
          "A post-flag motion target is missing before the preference change"
        )
      let started = false
      const begin = () => {
        if (started || node.getAttribute("data-motion-reduced") !== "true")
          return
        started = true
        observer.disconnect()
        let index = 0
        const collect = () => {
          targets.forEach((target, targetIndex) => {
            const element = target!,
              style = getComputedStyle(element)
            const matrix = new DOMMatrixReadOnly(
              style.transform === "none" ? undefined : style.transform
            )
            const scale =
              style.scale === "none"
                ? [1, 1]
                : style.scale.split(" ").map(Number)
            const translate =
              style.translate === "none"
                ? [0, 0]
                : style.translate.split(" ").map(Number.parseFloat)
            let offset: number | null = null,
              endpoint: number | null = null
            if (
              node.getAttribute("data-slot") === "switch" &&
              element.getAttribute("data-slot") === "switch-thumb"
            ) {
              const outer = node.getBoundingClientRect(),
                thumb = element.getBoundingClientRect(),
                trackStyle = getComputedStyle(node)
              const checked = node.getAttribute("aria-checked") === "true",
                rtl = trackStyle.direction === "rtl"
              const left =
                Number.parseFloat(trackStyle.borderLeftWidth) +
                Number.parseFloat(trackStyle.paddingLeft)
              const right =
                Number.parseFloat(trackStyle.borderRightWidth) +
                Number.parseFloat(trackStyle.paddingRight)
              offset = thumb.left - outer.left
              endpoint = (rtl ? checked : !checked)
                ? left
                : outer.width - right - thumb.width
            }
            if (
              node.getAttribute("data-slot") === "tabs-list" &&
              element.getAttribute("data-slot") === "tabs-indicator"
            ) {
              const selected = node
                .querySelector('[aria-selected="true"]')!
                .getBoundingClientRect()
              const indicator = element.getBoundingClientRect()
              offset = Math.max(
                Math.abs(selected.left - indicator.left),
                Math.abs(selected.top - indicator.top),
                Math.abs(selected.width - indicator.width),
                Math.abs(selected.height - indicator.height)
              )
              endpoint = 0
            }
            probe.frames.push({
              frame: index,
              target: targetIndex,
              connected: node.isConnected && element.isConnected,
              identity:
                Math.abs(matrix.a - 1) < 0.002 &&
                Math.abs(matrix.d - 1) < 0.002 &&
                Math.abs(matrix.b) < 0.002 &&
                Math.abs(matrix.c) < 0.002 &&
                Math.abs(matrix.e) < 0.5 &&
                Math.abs(matrix.f) < 0.5 &&
                scale.every((value) => Math.abs(value - 1) < 0.002) &&
                translate.every((value) => Math.abs(value) < 0.5),
              blurred:
                style.filter !== "none" &&
                !/^blur\(0(?:px)?\)$/.test(style.filter),
              offset,
              endpoint,
              transform: style.transform,
              filter: style.filter,
            })
          })
          if (++index < 6) requestAnimationFrame(collect)
          else probe.done = true
        }
        requestAnimationFrame(collect)
      }
      const observer = new MutationObserver(begin)
      observer.observe(node, {
        attributes: true,
        attributeFilter: ["data-motion-reduced"],
      })
      begin()
    },
    { id, selectors }
  )
  return id
}
async function reducedFrames(page: Page, id: string, targets = 1) {
  // Wait for the independent recording, never for spatial styles to settle.
  // MutationObserver arms the recorder before the OS preference changes, so an
  // assertion polling the data attribute cannot miss the first rendered frames.
  await page.waitForFunction(
    (key) =>
      (
        window as unknown as {
          __uiReducedProbes?: Record<string, ReducedProbe>
        }
      ).__uiReducedProbes?.[key]?.done,
    id
  )
  const frames = await page.evaluate(
    (key) =>
      (window as unknown as { __uiReducedProbes: Record<string, ReducedProbe> })
        .__uiReducedProbes[key]!.frames,
    id
  )
  expect(frames).toHaveLength(6 * targets)
  return frames
}
function assertImmediateSpatialStop(frames: readonly ReducedFrame[]) {
  for (const sample of frames) {
    expect(sample.connected, JSON.stringify(sample)).toBe(true)
    expect(
      sample.identity,
      `Spatial movement after the reduced flag: ${JSON.stringify(sample)}`
    ).toBe(true)
    expect(
      sample.blurred,
      `Blur after the reduced flag: ${JSON.stringify(sample)}`
    ).toBe(false)
  }
}
async function sampleThumbOffsets(track: Locator, count: number) {
  return track.evaluate(async (node, frames) => {
    const samples: {
      absoluteLeft: number
      offset: number
      endpoint: number
    }[] = []
    for (let n = 0; n < frames; n++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      const outer = node.getBoundingClientRect(),
        thumb = node
          .querySelector('[data-slot="switch-thumb"]')!
          .getBoundingClientRect(),
        style = getComputedStyle(node)
      const checked = node.getAttribute("aria-checked") === "true",
        rtl = style.direction === "rtl"
      const left =
        Number.parseFloat(style.borderLeftWidth) +
        Number.parseFloat(style.paddingLeft)
      const right =
        Number.parseFloat(style.borderRightWidth) +
        Number.parseFloat(style.paddingRight)
      samples.push({
        absoluteLeft: thumb.left,
        offset: thumb.left - outer.left,
        endpoint: (rtl ? checked : !checked)
          ? left
          : outer.width - right - thumb.width,
      })
    }
    return samples
  }, count)
}
async function frame(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  )
}
async function moveTo(page: Page, locator: Locator) {
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
}
async function pressWithoutWaitingForStability(page: Page, locator: Locator) {
  await moveTo(page, locator)
  await page.mouse.down()
  await frame(page)
  await page.mouse.up()
}
async function rapidClicks(page: Page, locator: Locator, count: number) {
  await moveTo(page, locator)
  for (let n = 0; n < count; n++) {
    await page.mouse.down()
    await page.mouse.up()
    await frame(page)
  }
}
async function nativeClick(locator: Locator) {
  // Native owner receives a reopen while its retained backdrop still prevents a
  // pointer hit. Waiting for Playwright click stability would miss this race.
  await locator.evaluate((node) => (node as HTMLElement).click())
}
async function thumbSide(track: Locator) {
  return track.evaluate((node) => {
    const outer = node.getBoundingClientRect(),
      thumb = node
        .querySelector('[data-slot="switch-thumb"]')!
        .getBoundingClientRect()
    return thumb.left + thumb.width / 2 < outer.left + outer.width / 2
      ? "left"
      : "right"
  })
}
async function markerWithin(group: Locator, selector: string) {
  return group.evaluate((node, marker) => {
    const selected = node.querySelector('[aria-pressed="true"]'),
      indicator = node.querySelector(marker)
    if (!selected || !indicator) return false
    const a = selected.getBoundingClientRect(),
      b = indicator.getBoundingClientRect(),
      own = node.getBoundingClientRect()
    return (
      b.left >= own.left - 1 &&
      b.right <= own.right + 1 &&
      Math.abs(a.left + a.width / 2 - b.left - b.width / 2) < 1.5 &&
      Math.abs(a.top + a.height / 2 - b.top - b.height / 2) < 1.5
    )
  }, selector)
}
async function sampleMarkerBounds(group: Locator, selector: string) {
  return group.evaluate(async (node, marker) => {
    const positions: boolean[] = []
    for (let n = 0; n < 20; n++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      const own = node.getBoundingClientRect()
      for (const indicator of node.querySelectorAll(marker)) {
        const rect = indicator.getBoundingClientRect()
        positions.push(
          rect.left >= own.left - 1.5 &&
            rect.right <= own.right + 1.5 &&
            rect.top >= own.top - 1.5 &&
            rect.bottom <= own.bottom + 1.5
        )
      }
    }
    return positions
  }, selector)
}
async function infiniteAnimations(locator: Locator) {
  return locator.evaluate(
    (node) =>
      node
        .getAnimations({ subtree: true })
        .filter(
          (animation) =>
            animation.playState === "running" &&
            animation.effect?.getTiming().iterations === Infinity
        ).length
  )
}
async function assertShortOpacityOnly(locator: Locator) {
  const animations = await locator.evaluateAll((nodes) =>
    nodes.flatMap((node) =>
      node.getAnimations({ subtree: true }).map((animation) => {
        const timing = animation.effect?.getTiming()
        const frames =
          animation.effect instanceof KeyframeEffect
            ? animation.effect.getKeyframes()
            : []
        const moving = [
          "transform",
          "translate",
          "scale",
          "rotate",
          "filter",
        ].filter(
          (key) =>
            new Set(frames.map((value) => value[key as keyof ComputedKeyframe]))
              .size > 1
        )
        return {
          duration: timing?.duration,
          iterations: timing?.iterations,
          moving,
        }
      })
    )
  )
  for (const animation of animations) {
    expect(animation.iterations).not.toBe(Infinity)
    expect(animation.moving).toEqual([])
    if (typeof animation.duration === "number")
      expect(animation.duration).toBeLessThanOrEqual(200)
  }
}
async function assertIconOpacityConfig(icon: Locator) {
  const layers = await icon
    .locator('[data-slot="icon-swap-active"], [data-slot="icon-swap-inactive"]')
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const style = getComputedStyle(node)
        const milliseconds = (value: string) =>
          Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000)
        return {
          properties: style.transitionProperty
            .split(",")
            .map((value) => value.trim()),
          durations: style.transitionDuration.split(",").map(milliseconds),
          delays: style.transitionDelay.split(",").map(milliseconds),
        }
      })
    )
  expect(layers).toHaveLength(2)
  for (const layer of layers) {
    expect(layer.properties).toEqual(["opacity"])
    expect(layer.durations).toHaveLength(1)
    expect(layer.durations[0]).toBeGreaterThan(0)
    expect(
      layer.durations[0]! + Math.max(0, layer.delays[0] ?? 0)
    ).toBeLessThanOrEqual(101)
  }
}
async function sampleCssOpacity(layer: Locator) {
  return layer.evaluate(async (node) => {
    const samples: { opacity: string; transitions: number[] }[] = []
    for (let frame = 0; frame < 12; frame++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      samples.push({
        opacity: getComputedStyle(node).opacity,
        // An old finite Motion geometry effect may finish behind the important
        // painted-property gate. Only the actual CSS opacity owner is timed.
        transitions: node
          .getAnimations()
          .filter(
            (animation) =>
              animation instanceof CSSTransition &&
              animation.transitionProperty === "opacity"
          )
          .map((animation) => Number(animation.effect?.getTiming().duration)),
      })
    }
    return samples
  })
}
async function usableFocus(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement
        return (
          !!active &&
          active !== document.body &&
          !active.matches("[data-base-ui-focus-guard]") &&
          !active.closest('[aria-hidden="true"], [inert]')
        )
      })
    )
    .toBe(true)
  await expect(page.locator(":focus")).toBeVisible()
}
async function swipeDown(page: Page, handle: Locator) {
  // Entry keeps the handle visible while moving it. Observe three consecutive
  // stable animation frames before fixing touch coordinates; no timing guess.
  const box = await stableGeometry(handle)
  const client = await page.context().newCDPSession(page)
  const x = box.x + box.width / 2,
    start = box.y + Math.min(box.height / 2, 12)
  let accepted = false
  try {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y: start }],
    })
    for (const offset of [30, 70, 120, 180, 250]) {
      await client.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [
          { x, y: Math.min(start + offset, page.viewportSize()!.height - 5) },
        ],
      })
      await frame(page)
      accepted ||= await handle.evaluate((node) => {
        const popup = node.closest(".responsive-overlay")
        return (
          !!popup &&
          (popup.hasAttribute("data-swiping") ||
            Math.abs(
              Number.parseFloat(
                getComputedStyle(popup).getPropertyValue(
                  "--drawer-swipe-movement-y"
                )
              )
            ) > 1)
        )
      })
    }
    await client.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
    expect(
      accepted,
      "The native Drawer must visibly accept the trusted touch drag"
    ).toBe(true)
  } finally {
    await client.detach()
  }
}
async function stableGeometry(locator: Locator) {
  return locator.evaluate(async (node) => {
    let previous: DOMRect | undefined,
      stable = 0
    for (let n = 0; n < 120; n++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      const rect = node.getBoundingClientRect()
      if (
        previous &&
        Math.abs(rect.x - previous.x) < 0.25 &&
        Math.abs(rect.y - previous.y) < 0.25 &&
        Math.abs(rect.width - previous.width) < 0.25 &&
        Math.abs(rect.height - previous.height) < 0.25
      )
        stable++
      else stable = 0
      if (stable >= 3 && rect.width > 0 && rect.height > 0)
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      previous = rect
    }
    throw new Error("Native overlay did not reach stable entry geometry")
  })
}

async function tabIndicatorAligned(list: Locator) {
  const samples = await sampleTabs(list, 1)
  return samples.every((sample) => sample.distance < 1.5)
}
async function sampleTabs(list: Locator, count: number) {
  return list.evaluate(async (node, frames) => {
    const samples = []
    for (let index = 0; index < frames; index++) {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
      const selected = node.querySelector('[aria-selected="true"]')!
      const marker = node.querySelector('[data-slot="tabs-indicator"]')!
      const tab = selected.getBoundingClientRect(),
        indicator = marker.getBoundingClientRect(),
        own = node.getBoundingClientRect()
      const panel = document.getElementById(
        selected.getAttribute("aria-controls")!
      )
      samples.push({
        selected: selected.textContent,
        distance: Math.max(
          Math.abs(tab.left - indicator.left),
          Math.abs(tab.top - indicator.top),
          Math.abs(tab.width - indicator.width),
          Math.abs(tab.height - indicator.height)
        ),
        contained:
          indicator.left >= own.left - 1.5 &&
          indicator.right <= own.right + 1.5 &&
          indicator.top >= own.top - 1.5 &&
          indicator.bottom <= own.bottom + 1.5,
        panelVisible:
          !!panel &&
          !panel.hidden &&
          getComputedStyle(panel).display !== "none",
        labelsStill: [...node.querySelectorAll('[role="tab"]')].every(
          (tab) =>
            getComputedStyle(tab).transform === "none" &&
            getComputedStyle(tab).translate === "none"
        ),
      })
    }
    return samples
  }, count)
}
