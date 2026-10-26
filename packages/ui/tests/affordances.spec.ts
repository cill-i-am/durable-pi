import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

async function openStory(
  page: Page,
  info: TestInfo,
  id: string,
  options: { scale?: 100 | 200; direction?: "ltr" | "rtl" } = {}
) {
  const params = new URLSearchParams({
    id,
    viewMode: "story",
    embed: "true",
    globals: `theme:${info.project.metadata.theme === "dark" ? "dark" : "light"};textScale:${options.scale ?? 100};direction:${options.direction ?? "ltr"}`,
  })
  await page.goto(`/iframe.html?${params}`)
  await page.waitForFunction((storyId) => {
    const render = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          currentRender?: { id?: string; phase?: string }
        }
      }
    ).__STORYBOOK_PREVIEW__?.currentRender
    return render?.id === storyId && render.phase === "finished"
  }, id)
  await expect(page.locator("#storybook-root")).toBeVisible()
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible()
  await expect(page.locator("html")).toHaveCSS(
    "font-size",
    options.scale === 200 ? "32px" : "16px"
  )
  await expect(page.locator("html")).toHaveAttribute(
    "dir",
    options.direction ?? "ltr"
  )
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

async function pauseTooltipClock(page: Page) {
  const now = new Date("2026-10-26T12:00:00Z")
  await page.clock.install({ time: now })
  await page.clock.pauseAt(new Date(now.getTime() + 60_000))
}

async function moveTo(page: Page, target: Locator) {
  const bounds = await target.boundingBox()
  if (!bounds) throw new Error("Tooltip trigger must occupy visible bounds")
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  )
}

test("disabled tabs look unavailable, ignore hover and retain native keyboard admission", async ({
  page,
}, info) => {
  await openStory(page, info, "components-tabs--default")
  const active = page.getByRole("tab", { name: "Active", exact: true })
  const unavailable = page.getByRole("tab", {
    name: "Unavailable",
    exact: true,
  })
  await expect(unavailable).toHaveAttribute("data-disabled", "")
  await expect(unavailable).toHaveAttribute("aria-disabled", "true")
  await expect(unavailable).toHaveCSS("opacity", "0.5")
  await expect(unavailable).toHaveCSS("cursor", "not-allowed")
  const before = await unavailable.evaluate((node) => {
    const style = getComputedStyle(node)
    return { background: style.backgroundColor, color: style.color }
  })
  await unavailable.hover()
  await expect(unavailable).toHaveCSS("background-color", before.background)
  await expect(unavailable).toHaveCSS("color", before.color)
  const bounds = await unavailable.boundingBox()
  if (!bounds) throw new Error("Disabled tab must occupy visible bounds")
  await page.mouse.click(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  )
  await expect(active).toHaveAttribute("aria-selected", "true")
  await active.focus()
  await active.press("End")
  await expect(unavailable).toBeFocused()
  await unavailable.press("Enter")
  await expect(unavailable).toHaveAttribute("aria-selected", "false")
  await expect(active).toHaveAttribute("aria-selected", "true")
  await expect(unavailable).toHaveCSS("box-shadow", /4px/)
})

test("checkbox and switch hit targets reach 44px without colliding with other controls", async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  for (const scale of [100, 200] as const) {
    for (const direction of ["ltr", "rtl"] as const) {
      await openStory(page, info, "compositions-forms--selection-controls", {
        scale,
        direction,
      })
      const geometry = await page.evaluate(() => {
        const roots = [
          ...document.querySelectorAll<HTMLElement>(
            '[data-slot="checkbox"], [data-slot="switch"], [data-slot="toggle-group-item"]'
          ),
        ]
        const targets = roots.map((node) => {
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          const after = getComputedStyle(node, "::after")
          const expanded = node.matches(
            '[data-slot="checkbox"], [data-slot="switch"]'
          )
          const left = expanded
            ? rect.left +
              parseFloat(style.borderLeftWidth) +
              parseFloat(after.left)
            : rect.left
          const top = expanded
            ? rect.top +
              parseFloat(style.borderTopWidth) +
              parseFloat(after.top)
            : rect.top
          const width = expanded ? parseFloat(after.width) : rect.width
          const height = expanded ? parseFloat(after.height) : rect.height
          return {
            slot: node.dataset.slot,
            name: node.id || node.textContent,
            expanded,
            left,
            top,
            width,
            height,
          }
        })
        const collisions = targets.flatMap((a, index) =>
          targets.slice(index + 1).flatMap((b) => {
            const width =
              Math.min(a.left + a.width, b.left + b.width) -
              Math.max(a.left, b.left)
            const height =
              Math.min(a.top + a.height, b.top + b.height) -
              Math.max(a.top, b.top)
            return width > 0.5 && height > 0.5 ? [{ a, b, width, height }] : []
          })
        )
        return { targets, collisions }
      })
      const expanded = geometry.targets.filter((target) => target.expanded)
      expect(expanded.length).toBeGreaterThan(0)
      for (const target of expanded) {
        expect(target.width, JSON.stringify(target)).toBeGreaterThanOrEqual(44)
        expect(target.height, JSON.stringify(target)).toBeGreaterThanOrEqual(44)
        if (scale === 100) {
          expect(target.width).toBe(44)
          expect(target.height).toBe(44)
        }
      }
      expect(geometry.collisions).toEqual([])
    }
  }
})

for (const slot of ["checkbox", "switch"] as const) {
  test(`${slot}: the outer hit area activates without changing visible geometry`, async ({
    page,
  }, info) => {
    await openStory(page, info, "compositions-forms--selection-controls")
    const control = page.getByRole(slot, { name: "Off", exact: true })
    const geometry = await control.evaluate((node) => {
      const rect = node.getBoundingClientRect()
      const style = getComputedStyle(node)
      const after = getComputedStyle(node, "::after")
      return {
        width: rect.width,
        height: rect.height,
        x:
          rect.left +
          parseFloat(style.borderLeftWidth) +
          parseFloat(after.left) +
          0.5,
        y: rect.top + rect.height / 2,
      }
    })
    expect({ width: geometry.width, height: geometry.height }).toEqual(
      slot === "checkbox"
        ? { width: 18, height: 18 }
        : { width: 36, height: 22 }
    )
    await expect(control).not.toBeChecked()
    if (info.project.use.hasTouch) {
      await page.touchscreen.tap(geometry.x, geometry.y)
    } else {
      await page.mouse.click(geometry.x, geometry.y)
    }
    await expect(control).toBeChecked()
    const after = await control.boundingBox()
    expect(after?.width).toBe(geometry.width)
    expect(after?.height).toBe(geometry.height)
  })
}

test("sheet back labels reuse two rows at 390px with enlarged text in either direction", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 })
  for (const direction of ["ltr", "rtl"] as const) {
    await openStory(page, info, "compositions-settings--long-labels", {
      direction,
    })
    const sheet = page.getByRole("dialog", {
      name: "Model access for the whole family",
      exact: true,
    })
    const navigation = sheet.locator(".sheet-navigation")
    await expect(navigation).toHaveCSS(
      "grid-template-columns",
      /^76px .+ 76px$/
    )
    await openStory(page, info, "compositions-settings--long-labels", {
      direction,
      scale: 200,
    })
    await expect(navigation.locator(".sheet-navigation-title")).toHaveCSS(
      "grid-row-start",
      "2"
    )
    const back = sheet.getByRole("button", {
      name: "Family settings",
      exact: true,
    })
    const bounds = await back.boundingBox()
    const leading = await navigation
      .locator(".sheet-navigation-leading")
      .boundingBox()
    expect(leading?.width).toBeGreaterThan(200)
    expect(bounds?.width).toBeGreaterThan(76)
    expect(bounds?.height).toBeLessThan(80)
    const title = await navigation
      .locator(".sheet-navigation-title")
      .boundingBox()
    expect(title?.y).toBeGreaterThanOrEqual(
      (bounds?.y ?? 0) + (bounds?.height ?? 0)
    )
    const overflow = await page.evaluate(() => ({
      width: document.documentElement.clientWidth,
      content: document.documentElement.scrollWidth,
    }))
    expect(overflow.content).toBeLessThanOrEqual(overflow.width)
  }
})

test("tooltips ignore a brief pointer pass, then open after dwell and share the native fast path", async ({
  page,
}, info) => {
  await openStory(page, info, "components-tooltip--shared-provider")
  await pauseTooltipClock(page)
  const notes = page.getByRole("button", { name: "Family notes", exact: true })
  const lists = page.getByRole("button", { name: "Shared lists", exact: true })
  await moveTo(page, notes)
  await page.clock.runFor(40)
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await page.mouse.move(0, 0)
  await page.clock.runFor(300)
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await moveTo(page, notes)
  await page.clock.runFor(199)
  await expect(page.getByRole("tooltip")).toHaveCount(0)
  await page.clock.runFor(1)
  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toHaveText("Open family notes")
  await expect(tooltip).toHaveClass(/tooltip-caller-open/)
  await page.clock.runFor(200)
  await moveTo(page, lists)
  const adjacent = page
    .getByRole("tooltip")
    .filter({ hasText: "Open shared lists" })
  await expect(adjacent).toHaveText("Open shared lists")
  await expect(adjacent).toHaveAttribute("data-instant", "delay")
  await expect(adjacent).toHaveCSS("transition-duration", "0s")
})

test("tooltips give keyboard help immediately and preserve explicit pointer-delay overrides", async ({
  page,
}, info) => {
  await openStory(page, info, "components-tooltip--shared-provider")
  await pauseTooltipClock(page)
  await page.keyboard.press("Tab")
  const tooltip = page.getByRole("tooltip")
  await expect(tooltip).toHaveText("Open family notes")
  await expect(tooltip).toHaveClass(/tooltip-caller-open/)
  await expect(tooltip).toHaveAttribute("data-instant", "focus")
  await expect(tooltip).toHaveCSS("transition-duration", "0s")
  await page.keyboard.press("Escape")
  await expect(tooltip).toHaveCount(0)
  await page.clock.resume()
  await openStory(page, info, "components-tooltip--immediate-pointer")
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000))
  await moveTo(
    page,
    page.getByRole("button", { name: "Family notes", exact: true })
  )
  await page.clock.runFor(1)
  await expect(page.getByRole("tooltip")).toHaveText("Open family notes")
})
