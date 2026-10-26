import { expect, test, type Page, type TestInfo } from "@playwright/test"

async function openStory(
  page: Page,
  info: TestInfo,
  id: string,
  direction: "ltr" | "rtl" = "ltr"
) {
  const params = new URLSearchParams({
    id,
    viewMode: "story",
    embed: "true",
    globals: `theme:${info.project.metadata.theme === "dark" ? "dark" : "light"};direction:${direction}`,
  })
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
  await expect(page.locator("html")).toHaveAttribute("dir", direction)
}

const browserErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  browserErrors.set(page, errors)
  page.on("pageerror", (error) => errors.push(error.message))
})
test.afterEach(({ page }) => {
  expect(
    browserErrors.get(page),
    "No caller or native browser exception"
  ).toEqual([])
})

for (const activation of ["pointer", "keyboard"] as const) {
  test(`menu: ${activation} click has a live currentTarget and closes natively`, async ({
    page,
  }, info) => {
    await openStory(page, info, "components-dropdownmenu--native-contracts")
    await page
      .getByRole("button", { name: "Contract actions", exact: true })
      .click()
    const item = page.getByRole("menuitem", {
      name: "Read current target",
      exact: true,
    })
    if (activation === "pointer") await item.click()
    else {
      await item.focus()
      await page.keyboard.press("Enter")
    }
    await expect(
      page.locator('output[aria-label="Menu click result"]')
    ).toHaveText("read-target")
    await expect(page.getByRole("menu")).not.toBeVisible()
  })

  test(`menu: ${activation} caller can cancel the native close`, async ({
    page,
  }, info) => {
    await openStory(page, info, "components-dropdownmenu--native-contracts")
    await page
      .getByRole("button", { name: "Contract actions", exact: true })
      .click()
    const item = page.getByRole("menuitem", {
      name: "Cancel native close",
      exact: true,
    })
    if (activation === "pointer") await item.click()
    else {
      await item.focus()
      await page.keyboard.press("Enter")
    }
    await expect(
      page.locator('output[aria-label="Menu click result"]')
    ).toHaveText("cancelled")
    await expect(page.getByRole("menu")).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(page.getByRole("menu")).not.toBeVisible()
    await expect(
      page.getByRole("button", { name: "Contract actions", exact: true })
    ).toBeFocused()
  })
}

test("menu: closeOnClick=false keeps the native event and popup", async ({
  page,
}, info) => {
  await openStory(page, info, "components-dropdownmenu--native-contracts")
  await page
    .getByRole("button", { name: "Contract actions", exact: true })
    .click()
  await page
    .getByRole("menuitem", { name: "Keep menu open", exact: true })
    .click()
  await expect(
    page.locator('output[aria-label="Menu click result"]')
  ).toHaveText("kept-open")
  await expect(page.getByRole("menu")).toBeVisible()
})

test("menu and separator: className callbacks receive native render state", async ({
  page,
}, info) => {
  await openStory(page, info, "components-dropdownmenu--native-contracts")
  await expect(page.locator('[data-slot="separator"]')).toHaveClass(
    /contract-separator-horizontal/
  )
  await page
    .getByRole("button", { name: "Contract actions", exact: true })
    .click()
  for (const [slot, expectedClass] of [
    ["dropdown-menu-content", "contract-content-open"],
    ["dropdown-menu-group", "contract-group"],
    ["dropdown-menu-label", "contract-label"],
    ["dropdown-menu-item", "contract-item"],
    ["dropdown-menu-separator", "contract-menu-separator"],
    ["dropdown-menu-checkbox-item", "contract-checked"],
    ["dropdown-menu-radio-item", "contract-radio"],
    ["dropdown-menu-sub-trigger", "contract-sub-trigger"],
  ] as const) {
    await expect(page.locator(`[data-slot="${slot}"]`).first()).toHaveClass(
      new RegExp(expectedClass)
    )
  }
  const menu = page.getByRole("menu")
  await menu.focus()
  await page.keyboard.press("Home")
  await expect(
    page.getByRole("menuitem", { name: "Read current target", exact: true })
  ).toHaveClass(/contract-highlighted/)
  await page
    .getByRole("menuitemcheckbox", { name: "Show descriptions", exact: true })
    .click()
  await expect(
    page.getByRole("menuitemcheckbox", {
      name: "Show descriptions",
      exact: true,
    })
  ).not.toHaveClass(/contract-checked/)
})

test("menu: native dialog handoff retains focus through menu cleanup", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await openStory(page, info, "components-dropdownmenu--native-dialog-handoff")
  const trigger = page.getByRole("button", {
    name: "Skill actions",
    exact: true,
  })
  await trigger.click()
  await page
    .getByRole("menuitem", { name: "View skill details", exact: true })
    .click()
  const dialog = page.getByRole("dialog", {
    name: "Skill details",
    exact: true,
  })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole("menu")).not.toBeVisible()
  // Wait for the native drawer's exit transition and presence cleanup before
  // checking focus. An immediate check could miss a later focus restoration.
  await expect(page.locator(".responsive-popup-shell")).toHaveCount(0)
  await expect
    .poll(() =>
      dialog.evaluate((node) => node.contains(document.activeElement))
    )
    .toBe(true)
  await page.getByRole("button", { name: "Done", exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test("menu: RTL submenu uses a logical placement and directional cue", async ({
  page,
}, info) => {
  await openStory(
    page,
    info,
    "components-dropdownmenu--native-contracts",
    "rtl"
  )
  await page
    .getByRole("button", { name: "Contract actions", exact: true })
    .click()
  const trigger = page.getByRole("menuitem", {
    name: "More actions",
    exact: true,
  })
  await expect(trigger.locator("svg")).toHaveCSS("rotate", "180deg")
  const indicator = page.locator(
    '[data-slot="dropdown-menu-checkbox-item-indicator"]'
  )
  const checkbox = page.getByRole("menuitemcheckbox", {
    name: "Show descriptions",
    exact: true,
  })
  const indicatorBox = (await indicator.boundingBox())!
  const checkboxBox = (await checkbox.boundingBox())!
  expect(indicatorBox.x + indicatorBox.width / 2).toBeLessThan(
    checkboxBox.x + checkboxBox.width / 2
  )
  await trigger.click()
  const nested = page.getByRole("menu").filter({
    has: page.getByRole("menuitem", { name: "Nested action", exact: true }),
  })
  await expect(nested).toBeVisible()
  if (info.project.name.startsWith("desktop")) {
    // The centered fixture leaves room on the logical end; Base UI still owns
    // collision flipping when callers place the trigger nearer a viewport edge.
    await expect(nested).toHaveAttribute("data-side", "inline-end")
    const popupBox = (await nested.boundingBox())!
    const triggerBox = (await trigger.boundingBox())!
    expect(popupBox.x + popupBox.width).toBeLessThanOrEqual(triggerBox.x + 1)
  }
})

test("menu: visible mobile Back uses the native submenu close and restores its parent", async ({
  page,
}, info) => {
  test.skip(
    !info.project.name.startsWith("phone"),
    "Back belongs to nested phone sheets"
  )
  await openStory(page, info, "components-dropdownmenu--native-contracts")
  await page
    .getByRole("button", { name: "Contract actions", exact: true })
    .click()
  await expect(
    page.getByRole("menuitem", {
      name: "Back to contract actions",
      exact: true,
    })
  ).toHaveCount(0)
  await page
    .getByRole("menuitem", { name: "More actions", exact: true })
    .click()
  const back = page.getByRole("menuitem", {
    name: "Back to contract actions",
    exact: true,
  })
  await expect(back).toBeVisible()
  await back.focus()
  await page.keyboard.press("Enter")
  await expect(
    page.getByRole("menuitem", { name: "Nested action", exact: true })
  ).not.toBeVisible()
  await expect(
    page.getByRole("menuitem", { name: "More actions", exact: true })
  ).toBeFocused()
  await expect(
    page.getByRole("menuitem", { name: "Read current target", exact: true })
  ).toBeVisible()
})

test("table: RTL defaults align to start and explicit numeric alignment survives", async ({
  page,
}, info) => {
  await openStory(page, info, "components-table--default", "rtl")
  await expect(
    page.getByRole("columnheader", { name: "Skill", exact: true })
  ).toHaveCSS("text-align", "start")
  await expect(page.locator('[data-slot="table-caption"]')).toHaveCSS(
    "text-align",
    "start"
  )
  await expect(
    page.getByRole("columnheader", { name: "Version", exact: true })
  ).toHaveCSS("text-align", "right")
  await expect(page.getByRole("cell", { name: "2", exact: true })).toHaveCSS(
    "text-align",
    "right"
  )
})
