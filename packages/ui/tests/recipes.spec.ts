import { expect, test, type Page, type TestInfo } from "@playwright/test"

const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on("pageerror", (error) => errors.push(error.message))
})
test.afterEach(({ page }) => {
  expect(pageErrors.get(page), "Uncaught recipe exceptions").toEqual([])
})

async function openRecipe(
  page: Page,
  info: TestInfo,
  id: string,
  options: { scale?: 100 | 200; scenario?: "error" | "uncertain" } = {}
) {
  const theme = info.project.metadata.theme === "dark" ? "dark" : "light"
  const scale = options.scale ?? 100
  const params = new URLSearchParams({
    id,
    viewMode: "story",
    embed: "true",
    globals: `theme:${theme};textScale:${scale};direction:ltr`,
  })
  if (options.scenario) params.set("args", `scenario:${options.scenario}`)
  await page.goto(`/iframe.html?${params}`)
  await page.waitForFunction((storyId) => {
    const preview = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          currentRender?: { id?: string; phase?: string }
        }
      }
    ).__STORYBOOK_PREVIEW__
    return (
      preview?.currentRender?.id === storyId &&
      preview.currentRender.phase === "finished"
    )
  }, id)
  await expect(page.locator(".sb-errordisplay")).not.toBeVisible()
  await expect(page.locator("#storybook-root")).toBeVisible()
  await expect(page.locator("html")).toHaveCSS(
    "font-size",
    scale === 200 ? "32px" : "16px"
  )
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

test("failed Archive exposes a readable full-width alert and truthful retry result", async ({
  page,
}, info) => {
  await openRecipe(page, info, "compositions-recovery--failed-menu-action")
  const trigger = page.getByRole("button", { name: "Skill actions" })
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  const alert = page.getByRole("alert")
  await expect(alert).toContainText("Couldn’t archive")
  await expect(alert).toContainText("The simulated archive failed.")
  const layout = await alert.evaluate((element) => {
    const bounds = element.getBoundingClientRect()
    const parent = element.parentElement!.getBoundingClientRect()
    return {
      width: bounds.width,
      parentWidth: parent.width,
      height: bounds.height,
      textWidth: element
        .querySelector('[data-slot="alert-description"]')!
        .getBoundingClientRect().width,
    }
  })
  expect(layout.width).toBeGreaterThan(200)
  expect(Math.abs(layout.width - layout.parentWidth)).toBeLessThanOrEqual(1)
  expect(layout.textWidth).toBeGreaterThan(150)
  expect(layout.height).toBeLessThan(250)
  const retry = alert.getByRole("button", { name: "Retry", exact: true })
  await expect(retry).toBeInViewport()
  await retry.click()
  await expect(
    page.getByText("Archived in this simulation.", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("Saved in this simulation.", { exact: true })
  ).toHaveCount(0)
})

for (const scale of [100, 200] as const) {
  test(`product specifications ${scale === 200 ? "stack" : "retain two columns"} at 320px and ${scale}% text`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 320, height: 844 })
    await openRecipe(
      page,
      info,
      "compositions-card-recipes--long-content-and-narrow",
      { scale }
    )
    const rows = await page.locator("dl > div").evaluateAll((elements) =>
      elements.map((element) => {
        const term = element.querySelector("dt")!
        const value = element.querySelector("dd")!
        const termBox = term.getBoundingClientRect()
        const valueBox = value.getBoundingClientRect()
        const termRange = document.createRange()
        termRange.selectNodeContents(term)
        const valueRange = document.createRange()
        valueRange.selectNodeContents(value)
        const termInk = termRange.getBoundingClientRect()
        const valueInk = valueRange.getBoundingClientRect()
        return {
          label: term.textContent,
          termTop: termBox.top,
          termBottom: termBox.bottom,
          valueTop: valueBox.top,
          termLeft: termBox.left,
          valueLeft: valueBox.left,
          overlaps:
            termInk.left < valueInk.right &&
            termInk.right > valueInk.left &&
            termInk.top < valueInk.bottom &&
            termInk.bottom > valueInk.top,
          termOverflow: term.scrollWidth - term.clientWidth,
          valueOverflow: value.scrollWidth - value.clientWidth,
        }
      })
    )
    expect(rows.map((row) => row.label)).toEqual([
      "Battery",
      "Weight",
      "Noise cancelling",
    ])
    for (const row of rows) {
      expect(row.overlaps, `${row.label} ink must not overlap its value`).toBe(
        false
      )
      expect(row.termOverflow).toBeLessThanOrEqual(1)
      expect(row.valueOverflow).toBeLessThanOrEqual(1)
      if (scale === 200) {
        expect(row.valueTop).toBeGreaterThanOrEqual(row.termBottom)
        expect(Math.abs(row.valueLeft - row.termLeft)).toBeLessThanOrEqual(1)
      } else {
        expect(Math.abs(row.valueTop - row.termTop)).toBeLessThanOrEqual(1)
        expect(row.valueLeft).toBeGreaterThan(row.termLeft)
      }
    }
    const documentWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    )
    expect(documentWidth).toBeLessThanOrEqual(321)
  })
}

test("confirmed Disconnect has terminal confirmation and Close", async ({
  page,
}, info) => {
  await openRecipe(
    page,
    info,
    "compositions-settings--destructive-confirmation"
  )
  const trigger = page.getByRole("button", { name: "Disconnect connection" })
  await trigger.click()
  const popup = page.locator('[data-slot="alert-dialog-content"]:visible')
  await popup.getByRole("button", { name: "Disconnect", exact: true }).click()
  await expect(popup.getByRole("status")).toHaveText("Connection disconnected.")
  await expect(
    popup.getByRole("heading", { name: "Connection disconnected", exact: true })
  ).toBeVisible()
  await expect(
    popup.getByRole("button", { name: "Keep connection" })
  ).toHaveCount(0)
  await expect(
    popup.getByRole("button", { name: "Disconnect", exact: true })
  ).toHaveCount(0)
  await expect(
    popup.getByRole("button", { name: "Reset example" })
  ).toHaveCount(0)
  await popup.getByRole("button", { name: "Close", exact: true }).click()
  await expect(popup).toHaveCount(0)
  await expect(trigger).toBeFocused()
})

for (const scenario of ["error", "uncertain"] as const) {
  test(`Disconnect ${scenario} reports its own operation and recovers to terminal Close`, async ({
    page,
  }, info) => {
    await openRecipe(
      page,
      info,
      "compositions-settings--destructive-confirmation",
      { scenario }
    )
    await page.getByRole("button", { name: "Disconnect connection" }).click()
    const popup = page.locator('[data-slot="alert-dialog-content"]:visible')
    await popup.getByRole("button", { name: "Disconnect", exact: true }).click()
    if (scenario === "error") {
      await expect(popup.getByRole("alert")).toContainText(
        "Couldn’t disconnect."
      )
      await expect(popup.getByRole("alert")).not.toContainText("save")
      await popup.getByRole("button", { name: "Retry request" }).click()
    } else {
      await expect(popup.getByRole("status")).toContainText(
        "disconnect is unconfirmed"
      )
      await expect(
        popup.getByRole("button", { name: "Keep connection" })
      ).toHaveCount(0)
      await popup.getByRole("button", { name: "Check status" }).click()
    }
    await expect(popup.getByRole("status")).toHaveText(
      "Connection disconnected."
    )
    await expect(
      popup.getByRole("button", { name: "Close", exact: true })
    ).toBeVisible()
    await expect(
      popup.getByRole("button", { name: "Keep connection" })
    ).toHaveCount(0)
  })
}

test("keyboard Save retains the same focused button while pending and after completion", async ({
  page,
}, info) => {
  await openRecipe(page, info, "components-button--save-success")
  const save = page.locator('#storybook-root [data-slot="button"]').first()
  await expect(save).toBeEnabled()
  const original = await save.elementHandle()
  if (!original) throw new Error("The Save button must be mounted")
  await page.keyboard.press("Tab")
  await expect(save).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(save).toHaveText("Saving…")
  await expect(save).toHaveAttribute("aria-disabled", "true")
  await expect(save).not.toHaveAttribute("disabled")
  await expect(save).toBeFocused()
  await page.keyboard.press("Enter")
  await page.keyboard.press("Space")
  await expect(page.getByRole("status")).toHaveText("Default saved.")
  await expect(save).toHaveText("Saved")
  await expect(save).toBeDisabled()
  expect(
    await original.evaluate((element) => ({
      connected: element.isConnected,
      focused: document.activeElement === element,
      visibleFocus: element.matches(":focus-visible"),
    }))
  ).toEqual({ connected: true, focused: true, visibleFocus: true })
  await page.keyboard.press("Tab")
  await expect(
    page.getByRole("button", { name: "Reset example" })
  ).toBeFocused()
})

test("keyboard Save failure and retry preserve focus on the original control", async ({
  page,
}, info) => {
  await openRecipe(page, info, "components-button--save-error")
  const save = page.locator('#storybook-root [data-slot="button"]').first()
  await expect(save).toBeEnabled()
  await page.keyboard.press("Tab")
  await page.keyboard.press("Enter")
  await expect(page.getByRole("alert")).toContainText("Couldn’t save.")
  await expect(save).toHaveText("Try again")
  await expect(save).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(save).toHaveText("Saving…")
  await expect(save).toBeFocused()
  await expect(page.getByRole("status")).toHaveText("Default saved.")
  await expect(save).toHaveText("Saved")
  await expect(save).toBeFocused()
})
