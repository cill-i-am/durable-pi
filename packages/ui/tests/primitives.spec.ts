import { readFileSync } from "node:fs"

import AxeBuilder from "@axe-core/playwright"
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test"

type Story = { id: string; title: string; name: string; type: string }
const index = JSON.parse(
  readFileSync(
    new URL("../storybook-static/index.json", import.meta.url),
    "utf8"
  )
) as { entries: Record<string, Story> }
const stories = Object.values(index.entries)
  .filter((entry) => entry.type === "story")
  .sort((a, b) => a.id.localeCompare(b.id))
if (!stories.length)
  throw new Error(
    "Build Storybook before running its browser suite; index.json contains no stories."
  )

const diagnostics = new WeakMap<
  Page,
  { pageErrors: string[]; consoleErrors: string[] }
>()
test.beforeEach(async ({ page }) => {
  const log = { pageErrors: [] as string[], consoleErrors: [] as string[] }
  diagnostics.set(page, log)
  page.on("pageerror", (error) =>
    log.pageErrors.push(error.stack ?? error.message)
  )
  page.on("console", (message) => {
    if (message.type() === "error") log.consoleErrors.push(message.text())
  })
})
test.afterEach(async ({ page }, info) => {
  const log = diagnostics.get(page)
  if (!log) return
  if (log.pageErrors.length || log.consoleErrors.length)
    await info.attach("browser-errors", {
      body: JSON.stringify(log, null, 2),
      contentType: "application/json",
    })
  expect.soft(log.pageErrors, "Uncaught browser exceptions").toEqual([])
  expect
    .soft(
      log.consoleErrors.filter((message) =>
        /error rendering story|unable to render|no story found|failed to fetch dynamically imported|play function threw/i.test(
          message
        )
      ),
      "Storybook rendering errors"
    )
    .toEqual([])
})

function theme(info: TestInfo) {
  return info.project.metadata.theme === "dark" ? "dark" : "light"
}

async function openStory(
  page: Page,
  info: TestInfo,
  id: string,
  options: {
    scale?: 100 | 200
    direction?: "ltr" | "rtl"
    autoplay?: boolean
  } = {}
) {
  expect(
    stories.some((entry) => entry.id === id),
    `Required story ${id} must exist in the built index`
  ).toBe(true)
  const scale = options.scale ?? 100
  const direction = options.direction ?? "ltr"
  const params = new URLSearchParams({
    id,
    viewMode: "story",
    globals: `theme:${theme(info)};textScale:${scale};direction:${direction}`,
  })
  // Storybook 10.6's embed mode suppresses play functions for independent journeys.
  if (options.autoplay === false) params.set("embed", "true")
  await page.goto(`/iframe.html?${params}`)
  // Wait through loaders, render and existing play functions, rather than scanning
  // a transient loading state. This field is verified against pinned Storybook10.6.
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
  await expect(page.locator("body")).not.toHaveClass(
    /sb-show-errordisplay|sb-show-nopreview/
  )
  const root = page.locator("#storybook-root")
  await expect
    .poll(() => root.evaluate((element) => element.childElementCount), {
      message:
        "A story must mount element content, including SVG-only fixtures",
    })
    .toBeGreaterThan(0)
  await expect(root, "Mounted story must occupy visible bounds").toBeVisible()
  const lockedGlobals = await page.evaluate(() => {
    const preview = (
      window as unknown as {
        __STORYBOOK_PREVIEW__?: {
          currentRender?: { story?: { storyGlobals?: Record<string, unknown> } }
        }
      }
    ).__STORYBOOK_PREVIEW__
    return preview?.currentRender?.story?.storyGlobals ?? {}
  })
  const expectedTheme =
    lockedGlobals.theme === "dark" || lockedGlobals.theme === "light"
      ? lockedGlobals.theme
      : theme(info)
  if (lockedGlobals.theme && expectedTheme !== theme(info))
    info.annotations.push({
      type: "fixture-theme-lock",
      description: `${id} explicitly locks ${expectedTheme}; its theme is not overridden by the ${info.project.name} project.`,
    })
  await expect(page.locator("html")).toHaveAttribute("dir", direction)
  await expect(page.locator("html")).toHaveCSS(
    "font-size",
    scale === 200 ? "32px" : "16px"
  )
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((element) => element.classList.contains("dark"))
    )
    .toBe(expectedTheme === "dark")
  await page.evaluate(async () => {
    await document.fonts.ready
  })
}

async function noDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    viewport: document.documentElement.clientWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  expect(dimensions.document, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1
  )
  expect(dimensions.body, JSON.stringify(dimensions)).toBeLessThanOrEqual(
    dimensions.viewport + 1
  )
}

// Base UI's empty desktop sentinels redirect focus; axe cannot inspect React's
// delegated focus handler. Keep all content audited, and verify redirection below.
// https://github.com/mui/base-ui/issues/4668
const nativeGuardSelector =
  'html[data-ui-viewport="desktop"] span[data-base-ui-focus-guard][aria-hidden="true"]:empty'

async function recordNativeGuards(page: Page, info: TestInfo, label: string) {
  const guards = await page.evaluate(
    (selector) =>
      [...document.querySelectorAll(selector)].map((node) => {
        const style = getComputedStyle(node)
        return {
          type: node.getAttribute("data-type") ?? "trigger",
          children: node.childNodes.length,
          width: Number.parseFloat(style.width),
          height: Number.parseFloat(style.height),
          clip: style.clipPath,
          position: style.position,
        }
      }),
    nativeGuardSelector
  )
  if (!guards.length) return
  for (const guard of guards) {
    expect(guard.children).toBe(0)
    expect(guard.width).toBeLessThanOrEqual(1)
    expect(guard.height).toBeLessThanOrEqual(1)
    expect(guard.clip).toBe("inset(50%)")
    expect(guard.position).toBe("fixed")
  }
  info.annotations.push({
    type: "native-focus-guards",
    description: `${label}: ${guards.length} empty Base UI sentinel spans are inspected separately; no accessibility rule is disabled. See the dedicated keyboard test and upstream issue4668.`,
  })
  await info.attach(`native-focus-guards-${label}`, {
    body: JSON.stringify(
      { source: "https://github.com/mui/base-ui/issues/4668", guards },
      null,
      2
    ),
    contentType: "application/json",
  })
}

async function accessibility(page: Page, info: TestInfo, label: string) {
  await recordNativeGuards(page, info, label)
  const result = await new AxeBuilder({ page })
    .exclude(nativeGuardSelector)
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze()
  await info.attach(`axe-${label}`, {
    body: JSON.stringify(
      {
        url: page.url(),
        violations: result.violations,
        incomplete: result.incomplete,
        passedRules: result.passes.map((rule) => rule.id),
      },
      null,
      2
    ),
    contentType: "application/json",
  })
  for (const rule of result.incomplete)
    info.annotations.push({
      type: "a11y-incomplete",
      description: `${label}: ${rule.id} requires review (${rule.nodes.length} nodes). See axe attachment; this is not a pass.`,
    })
  expect
    .soft(
      result.violations.map((rule) => ({
        id: rule.id,
        impact: rule.impact,
        help: rule.help,
        nodes: rule.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      })),
      "Axe WCAG violations; incomplete results are reported separately"
    )
    .toEqual([])
}

async function tabTo(page: Page, locator: Locator) {
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press("Tab")
    if (await locator.evaluate((element) => element === document.activeElement))
      return
  }
  await expect(
    locator,
    "Control must be reachable through the natural tab order"
  ).toBeFocused()
}

for (const story of stories) {
  test(`story: ${story.title} / ${story.name}`, async ({ page }, info) => {
    await openStory(page, info, story.id)
    await noDocumentOverflow(page)
    await accessibility(page, info, story.id)
  })
}

test("card headers: actions align with their title and description without extra rows", async ({
  page,
}, info) => {
  for (const [id, prefix] of [
    ["components-card--with-action", "card"],
    ["components-cardframe--with-description", "card-frame"],
  ] as const) {
    await openStory(page, info, id, { autoplay: false })
    const header = page.locator(`[data-slot="${prefix}-header"]`)
    const geometry = await header.evaluate((node) => {
      const title = node
        .querySelector('[data-slot$="title"]')!
        .getBoundingClientRect()
      const description = node
        .querySelector('[data-slot$="description"]')!
        .getBoundingClientRect()
      const action = node
        .querySelector('[data-slot$="action"]')!
        .getBoundingClientRect()
      return {
        height: node.getBoundingClientRect().height,
        stacked:
          getComputedStyle(node).gridTemplateColumns.split(" ").length === 1,
        actionTop: action.top,
        descriptionBottom: description.bottom,
        textCenter: (title.top + description.bottom) / 2,
        actionCenter: (action.top + action.bottom) / 2,
      }
    })
    if (geometry.stacked) {
      expect(geometry.actionTop).toBeGreaterThanOrEqual(
        geometry.descriptionBottom
      )
      expect(geometry.height).toBeLessThanOrEqual(
        prefix === "card-frame" ? 110 : 116
      )
    } else {
      expect(
        Math.abs(geometry.textCenter - geometry.actionCenter)
      ).toBeLessThanOrEqual(1)
      expect(geometry.height).toBeLessThanOrEqual(
        prefix === "card-frame" ? 64 : 72
      )
    }
    await noDocumentOverflow(page)
  }
})

test("card frame: header action stays beside the title at phone width and grows with text", async ({
  page,
}, info) => {
  for (const scale of [100, 200] as const) {
    await openStory(page, info, "components-cardframe--header-and-action", {
      scale,
      autoplay: false,
    })
    const header = page.locator('[data-slot="card-frame-header"]')
    const title = page.getByRole("heading", { name: "Notes", exact: true })
    const action = page.getByRole("button", { name: "Add note", exact: true })
    await expect(title).toHaveCSS("font-size", `${(16 * scale) / 100}px`)
    if (scale === 100) {
      const titleBox = (await title.boundingBox())!,
        actionBox = (await action.boundingBox())!
      expect(
        Math.abs(
          titleBox.y + titleBox.height / 2 - actionBox.y - actionBox.height / 2
        )
      ).toBeLessThanOrEqual(1)
      expect((await header.boundingBox())!.height).toBeLessThanOrEqual(60)
    }
    await expect(
      page.locator('[data-slot="card-frame-description"]')
    ).toHaveCount(0)
    await noDocumentOverflow(page)
  }
})

test("button sizes: compact on fine-pointer desktops, generous on phones and wide touch devices", async ({
  page,
}, info) => {
  const touch = await page.evaluate(
    () => matchMedia("(any-pointer: coarse)").matches
  )
  for (const scale of [100, 200] as const) {
    await openStory(page, info, "components-button--sizes", {
      scale,
      autoplay: false,
    })
    const compact = await page.evaluate(
      () =>
        matchMedia("(min-width: 48rem)").matches &&
        matchMedia("(pointer: fine)").matches &&
        !matchMedia("(any-pointer: coarse)").matches
    )
    const heights = compact
      ? [32, 36, 44, 32, 36, 44]
      : [44, 44, 48, 44, 44, 48]
    const buttons = page
      .locator("section")
      .first()
      .locator('[data-slot="button"]')
    await expect(buttons).toHaveCount(6)
    for (let index = 0; index < heights.length; index++) {
      const box = (await buttons.nth(index).boundingBox())!
      expect(box.height).toBe((heights[index]! * scale) / 100)
      if (index >= 3) expect(box.width).toBe(box.height)
    }
    await noDocumentOverflow(page)
  }
  if (touch) {
    await page.setViewportSize({ width: 1280, height: 900 })
    await openStory(page, info, "components-button--default", {
      autoplay: false,
    })
    expect(
      (await page
        .getByRole("button", { name: "Save", exact: true })
        .boundingBox())!.height
    ).toBeGreaterThanOrEqual(44)
  }
})

test("catalogue: each primitive has independent docs and controls", async ({
  page,
}) => {
  // This journey checks the catalogue chrome, rather than a phone-sized specimen.
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto("/?path=/docs/components-input--reference")
  const navigation = page.getByRole("navigation", {
    name: "Stories",
    exact: true,
  })
  for (const name of [
    "Button",
    "Input",
    "Textarea",
    "Select",
    "Checkbox",
    "Switch",
    "Tabs",
    "Card",
    "CardFrame",
    "Sheet",
    "Dialog",
    "AlertDialog",
  ]) {
    await expect(
      navigation.getByRole("button", { name, exact: true })
    ).toBeVisible()
  }
  const preview = page.frameLocator("#storybook-preview-iframe")
  await expect(
    preview.getByRole("heading", { name: "Input", exact: true })
  ).toBeVisible()
  const placeholder = preview
    .getByRole("row")
    .filter({
      has: preview.getByRole("cell", { name: "placeholder", exact: true }),
    })
    .getByRole("textbox")
  await expect(placeholder).toBeVisible()
  await placeholder.fill("Family name")
  const specimen = preview.getByRole("textbox", { name: "Name", exact: true })
  await expect(specimen).toHaveAttribute("placeholder", "Family name")
  await specimen.fill("Family planning")
  const disabled = preview.getByRole("switch", {
    name: "disabled",
    exact: true,
  })
  await disabled.focus()
  await disabled.press("Space")
  await expect(specimen).toBeDisabled()
  await disabled.press("Space")
  await expect(specimen).toBeEnabled()
  await expect(specimen).toHaveValue("Family planning")
  await expect(
    preview.getByRole("cell", { name: "variant", exact: true })
  ).toHaveCount(0)

  await page.goto("/?path=/docs/components-button--reference")
  await expect(
    preview.getByRole("heading", { name: "Button", exact: true })
  ).toBeVisible()
  await expect(
    preview.getByRole("cell", { name: "variant", exact: true })
  ).toBeVisible()
})

test("menu: desktop sentinels redirect and native Tab restores focus", async ({
  page,
}, info) => {
  const id = "components-dropdownmenu--playground"
  await openStory(page, info, id, { autoplay: false })
  const count = await page.locator(nativeGuardSelector).count()
  if (info.project.name.startsWith("desktop"))
    expect(
      count,
      "Desktop menu exposes the native sentinels being audited separately"
    ).toBeGreaterThan(0)
  for (let index = 0; index < count; index++) {
    await openStory(page, info, id, { autoplay: false })
    const guard = await page
      .locator(nativeGuardSelector)
      .nth(index)
      .elementHandle()
    expect(guard).not.toBeNull()
    await guard!.focus()
    await expect
      .poll(() =>
        page.evaluate((previous) => {
          const active = document.activeElement
          return (
            !!active &&
            active !== previous &&
            active !== document.body &&
            !active.matches("[data-base-ui-focus-guard]") &&
            !active.closest('[aria-hidden="true"], [inert]')
          )
        }, guard)
      )
      .toBe(true)
    await expect(page.locator(":focus")).toBeVisible()
  }
  await openStory(page, info, id, { autoplay: false })
  const menu = page.getByRole("menu")
  await expect(menu).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(menu).not.toBeVisible()
  await expect(
    page.getByRole("button", { name: "Note actions", exact: true })
  ).toBeFocused()
})

test("select: pointer opening starts usable focus and Tab exits safely", async ({
  page,
}, info) => {
  await openStory(page, info, "components-select--default", { autoplay: false })
  const trigger = page.getByRole("combobox", { name: "Model", exact: true })
  await trigger.click()
  const list = page.getByRole("listbox")
  await expect(list).toBeVisible()
  if (info.project.name.startsWith("phone"))
    await expect(
      page.getByRole("option", { name: "GPT-6.1 Sol", exact: true })
    ).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(list).not.toBeVisible()
  await expect(page.locator("[data-base-ui-focus-guard]:focus")).toHaveCount(0)
  if (info.project.name.startsWith("phone")) await expect(trigger).toBeFocused()
})

test("menu: Tab leaves a nested menu with visible focus", async ({
  page,
}, info) => {
  await openStory(page, info, "components-dropdownmenu--playground", {
    autoplay: false,
  })
  await page.getByRole("menuitem", { name: "Theme", exact: true }).click()
  const choice = page.getByRole("menuitemradio", { name: "Light", exact: true })
  await expect(choice).toBeVisible()
  await choice.focus()
  await page.keyboard.press("Tab")
  await expect(choice).not.toBeVisible()
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
})

test("keyboard: button focus and opaque focus ring", async ({ page }, info) => {
  await openStory(page, info, "components-button--default", {
    autoplay: false,
  })
  const button = page.getByRole("button", { name: "Save", exact: true })
  await tabTo(page, button)
  await expect(button).toHaveCSS("border-radius", "10px")
  expect(
    await button.evaluate((element) => element.matches(":focus-visible"))
  ).toBe(true)
  expect(
    await button.evaluate((element) => getComputedStyle(element).boxShadow)
  ).toContain("4px")
  await button.press("Enter")
  await expect(button).toBeFocused()
})

test("keyboard: tabs select a panel and skip disabled controls", async ({
  page,
}, info) => {
  await openStory(page, info, "components-tabs--default", {
    autoplay: false,
  })
  const active = page.getByRole("tab", { name: "Active", exact: true })
  const archived = page.getByRole("tab", { name: "Archived", exact: true })
  await tabTo(page, active)
  await active.press("ArrowRight")
  await expect(archived).toBeFocused()
  await archived.press("Enter")
  await expect(archived).toHaveAttribute("aria-selected", "true")
  await expect(page.getByRole("tabpanel", { name: "Archived" })).toHaveText(
    "No archived skills."
  )
  await expect(page.getByRole("tab", { name: "Unavailable" })).toBeDisabled()
  expect(
    await archived.evaluate((element) => getComputedStyle(element).boxShadow)
  ).toContain("4px")
})

test("keyboard: checkbox, indeterminate, switch and single selection", async ({
  page,
}, info) => {
  await openStory(page, info, "compositions-forms--selection-controls", {
    autoplay: false,
  })
  const checkbox = page.getByRole("checkbox", { name: "Off", exact: true })
  await tabTo(page, checkbox)
  await checkbox.press("Space")
  await expect(checkbox).toBeChecked()
  await expect(
    page.getByRole("checkbox", { name: "Indeterminate", exact: true })
  ).toHaveAttribute("aria-checked", "mixed")
  await expect(
    page.getByRole("checkbox", { name: "Disabled", exact: true })
  ).toBeDisabled()
  const toggle = page.getByRole("switch", {
    name: "Activity animations",
    exact: true,
  })
  await toggle.focus()
  await toggle.press("Space")
  await expect(toggle).not.toBeChecked()
  const group = page.getByRole("group", { name: "Theme", exact: true })
  const light = group.getByRole("button", { name: "Light", exact: true })
  await light.focus()
  await light.press("Space")
  await expect(light).toHaveAttribute("aria-pressed", "true")
  await expect(
    group.getByRole("button", { name: "System", exact: true })
  ).toHaveAttribute("aria-pressed", "false")
})

test("keyboard: select opens, chooses an option and restores focus", async ({
  page,
}, info) => {
  await openStory(page, info, "components-select--default", {
    autoplay: false,
  })
  const trigger = page.getByRole("combobox", { name: "Model", exact: true })
  await tabTo(page, trigger)
  await trigger.press("ArrowDown")
  await expect(page.getByRole("listbox")).toBeVisible()
  await expect
    .poll(() =>
      page.evaluate(() => !!document.activeElement?.closest('[role="listbox"]'))
    )
    .toBe(true)
  await page.keyboard.press("Home")
  await expect(page.locator('[role="option"][data-highlighted]')).toContainText(
    "GPT-6.1 Sol"
  )
  await page.keyboard.press("ArrowDown")
  await expect(page.locator('[role="option"][data-highlighted]')).toContainText(
    "GPT-6 Astra"
  )
  await page.keyboard.press("Enter")
  await expect(trigger).toContainText("GPT-6 Astra")
  await expect(page.getByRole("listbox")).not.toBeVisible()
  await expect(trigger).toBeFocused()
})

test("select: failed options recover without replacing the field", async ({
  page,
}, info) => {
  await openStory(page, info, "components-select--error-recovery", {
    autoplay: false,
  })
  const trigger = page.getByRole("combobox", { name: "Model", exact: true })
  await expect(trigger).toBeDisabled()
  await expect(page.getByRole("alert")).toContainText("Models couldn’t load.")
  const node = await trigger.elementHandle()
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(trigger).toHaveAttribute("aria-busy", "true")
  await expect(trigger).toBeEnabled()
  await expect(page.getByRole("alert")).not.toBeVisible()
  expect(
    await trigger.evaluate((element, previous) => element === previous, node)
  ).toBe(true)
})

const operation = (page: Page) => page.getByTestId("lab-state")
const attempt = (page: Page) =>
  page
    .locator("dt")
    .filter({ hasText: /^Attempt$/ })
    .locator("xpath=following-sibling::dd[1]")
const receipt = (page: Page) =>
  page
    .locator("dt")
    .filter({ hasText: /^Receipt$/ })
    .locator("xpath=following-sibling::dd[1]")

test("lifecycle: successful save retains the entered draft", async ({
  page,
}, info) => {
  await openStory(page, info, "examination-lifecycle--explorer", {
    autoplay: false,
  })
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Family weekly plan")
  const save = page.getByRole("button", { name: "Save changes", exact: true })
  await expect(save).toBeEnabled()
  await save.click()
  await expect(operation(page)).toHaveText("loading")
  await expect(
    page.getByRole("button", { name: "Saving…", exact: true })
  ).toBeDisabled()
  await expect(operation(page)).toHaveText("success")
  await expect(receipt(page)).not.toHaveText("None")
  await expect(
    page.getByRole("textbox", { name: "Name", exact: true })
  ).toHaveValue("Family weekly plan")
})

test("lifecycle: known failure retries the same captured request", async ({
  page,
}, info) => {
  await openStory(page, info, "examination-lifecycle--known-failure", {
    autoplay: false,
  })
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(operation(page)).toHaveText("error")
  const original = await attempt(page).innerText()
  await page.getByRole("button", { name: "Try again", exact: true }).click()
  await expect(operation(page)).toHaveText("success")
  await expect(attempt(page)).toHaveText(original)
  await expect(receipt(page)).not.toHaveText("None")
})

test("lifecycle: an unconfirmed result is checked without resending", async ({
  page,
}, info) => {
  await openStory(page, info, "examination-lifecycle--lost-acknowledgement", {
    autoplay: false,
  })
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(operation(page)).toHaveText("uncertain")
  const original = await attempt(page).innerText()
  await expect(
    page.getByRole("button", { name: "Save changes", exact: true })
  ).toBeDisabled()
  await page.getByRole("button", { name: "Check result", exact: true }).click()
  await expect(operation(page)).toHaveText("success")
  await expect(attempt(page)).toHaveText(original)
  await expect(receipt(page)).not.toHaveText("None")
})

test("lifecycle: held work can be cancelled and reset", async ({
  page,
}, info) => {
  await openStory(page, info, "examination-lifecycle--hold-and-cancel", {
    autoplay: false,
  })
  const input = page.getByRole("textbox", { name: "Name", exact: true })
  await input.fill("Draft survives cancellation")
  await page.getByRole("button", { name: "Save changes", exact: true }).click()
  await expect(operation(page)).toHaveText("loading")
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(operation(page)).toHaveText("cancelled")
  await expect(input).toHaveValue("Draft survives cancellation")
  await page.getByRole("button", { name: "Reset", exact: true }).click()
  await expect(operation(page)).toHaveText("idle")
  await expect(attempt(page)).toHaveText("None")
  await expect(input).toBeEditable()
})

test("200% text: forms, actions and long drawer labels reflow", async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  for (const id of [
    "compositions-forms--editable-fields",
    "components-button--sizes",
    "components-tabs--default",
    "compositions-forms--selection-controls",
    "compositions-settings--long-labels",
  ]) {
    await openStory(page, info, id, { scale: 200, autoplay: false })
    await noDocumentOverflow(page)
    if (id.endsWith("editable-fields")) {
      const input = page.getByRole("textbox", { name: "Name", exact: true })
      await expect(input).toHaveCSS(
        "font-size",
        info.project.name.startsWith("phone") ? "32px" : "28px"
      )
      expect(
        await input.evaluate(
          (element) =>
            element.clientHeight >=
            Number.parseFloat(getComputedStyle(element).lineHeight)
        )
      ).toBe(true)
    }
    await accessibility(page, info, `200-${id}`)
  }
})

test("RTL: selection, select and drawer navigation keep direction", async ({
  page,
}, info) => {
  test.setTimeout(90_000)
  for (const id of [
    "compositions-forms--selection-controls",
    "components-select--default",
    "compositions-settings--long-labels",
  ]) {
    await openStory(page, info, id, { direction: "rtl", autoplay: false })
    await noDocumentOverflow(page)
    if (id === "components-select--default") {
      const trigger = page.getByRole("combobox", { name: "Model", exact: true })
      await trigger.click()
      await page
        .getByRole("option", { name: "GPT-6 Astra", exact: true })
        .click()
      await expect(trigger).toContainText("GPT-6 Astra")
      await expect(page.locator('[data-slot="select-value"]')).toHaveCSS(
        "text-align",
        "start"
      )
    }
    if (id.endsWith("long-labels")) {
      const dialog = page.getByRole("dialog", {
        name: "Model access for the whole family",
        exact: true,
      })
      const back = dialog.getByRole("button", {
        name: "Family settings",
        exact: true,
      })
      await expect(back).toBeVisible()
      expect(
        await back
          .locator("svg")
          .evaluate(
            (element) => (element as SVGSVGElement).getScreenCTM()?.a ?? 1
          ),
        "RTL back arrow points right"
      ).toBeLessThan(0)
    }
    await accessibility(page, info, `rtl-${id}`)
  }
})

test("drawers: back preserves draft, Escape restores the parent focus", async ({
  page,
}, info) => {
  await openStory(page, info, "compositions-settings--stacked-settings", {
    autoplay: false,
  })
  await page.getByRole("button", { name: "Open settings", exact: true }).click()
  await page.getByRole("button", { name: "Family", exact: true }).click()
  await page.getByRole("button", { name: "Model access", exact: true }).click()
  const model = page.getByRole("dialog", { name: "Model access", exact: true })
  const input = model.getByRole("textbox", {
    name: "Connection name",
    exact: true,
  })
  await input.fill("Family test connection")
  const original = await input.elementHandle()
  await model.getByRole("button", { name: "Family", exact: true }).click()
  const reopen = page.getByRole("button", { name: "Model access", exact: true })
  await expect(reopen).toBeFocused()
  await reopen.click()
  await expect(input).toHaveValue("Family test connection")
  expect(
    await input.evaluate((element, previous) => element === previous, original)
  ).toBe(true)
  await page.keyboard.press("Escape")
  await expect(reopen).toBeFocused()
})

test("drawers: wheel scrolls long content while the page stays locked", async ({
  page,
}, info) => {
  await openStory(page, info, "compositions-settings--long-content", {
    autoplay: false,
  })
  const dialog = page.getByRole("dialog", { name: "Model access", exact: true })
  const scroll = dialog.locator(":scope > .responsive-overlay-body")
  await expect(scroll).toBeVisible()
  await expect
    .poll(() =>
      scroll.evaluate((element) => element.scrollHeight - element.clientHeight)
    )
    .toBeGreaterThan(100)
  const box = await scroll.boundingBox()
  expect(box).not.toBeNull()
  if (!box) throw new Error("Visible drawer scroll area has no bounds")
  await scroll.hover({ position: { x: box.width / 2, y: box.height / 2 } })
  const before = await scroll.evaluate((element) => element.scrollTop)
  await page.mouse.wheel(0, 600)
  await expect
    .poll(() => scroll.evaluate((element) => element.scrollTop), {
      message: "A real wheel event must move the drawer's scroll container",
    })
    .toBeGreaterThan(before)
  expect(
    await page.evaluate(() => window.scrollY),
    "The underlying page must remain locked"
  ).toBe(0)
})

test("gradient labels: rendered endpoints meet 4.5:1", async ({
  page,
}, info) => {
  await openStory(page, info, "components-button--states")
  const result = await page.evaluate(() => {
    type Sample = {
      id: string
      text: string
      gradient: string
      endpoint: string
      foreground: string
      base: string
      ratio: number
    }
    const samples: Sample[] = []
    const incomplete: { id: string; reason: string }[] = []
    let inactiveExcluded = 0
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    const context = canvas.getContext("2d", { willReadFrequently: true })
    if (!context)
      throw new Error("Canvas2D is required for actual CSS-color compositing")
    const pixel = () =>
      Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3)
    const paint = (color: string) => {
      context.fillStyle = color
      context.fillRect(0, 0, 1, 1)
    }
    const luminance = (rgb: number[]) =>
      rgb.reduce((sum, byte, index) => {
        const channel = byte / 255
        return (
          sum +
          [0.2126, 0.7152, 0.0722][index]! *
            (channel <= 0.04045
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4)
        )
      }, 0)
    const splitTopLevel = (value: string) => {
      const parts: string[] = []
      let depth = 0
      let start = 0
      for (let i = 0; i < value.length; i++) {
        if (value[i] === "(") depth++
        else if (value[i] === ")") depth--
        else if (value[i] === "," && depth === 0) {
          parts.push(value.slice(start, i).trim())
          start = i + 1
        }
      }
      parts.push(value.slice(start).trim())
      return parts
    }
    const colorFromStop = (stop: string) => {
      let end = stop.indexOf("(")
      if (end >= 0) {
        let depth = 0
        for (let i = end; i < stop.length; i++) {
          if (stop[i] === "(") depth++
          if (stop[i] === ")" && --depth === 0) {
            end = i + 1
            break
          }
        }
      } else end = stop.search(/\s/)
      const candidate = end < 0 ? stop : stop.slice(0, end)
      return CSS.supports("color", candidate) ? candidate : null
    }
    const gradientEndpoints = (image: string) => {
      const layers = splitTopLevel(image)
      if (layers.length !== 1 || !layers[0]?.startsWith("linear-gradient("))
        return {
          reason:
            "Unsupported layered or non-linear image; manual contrast review required",
        }
      const stops = splitTopLevel(
        layers[0].slice(layers[0].indexOf("(") + 1, -1)
      )
        .map(colorFromStop)
        .filter((value): value is string => value !== null)
      if (stops.length < 2)
        return { reason: "Computed gradient endpoint colors were not resolved" }
      return { endpoints: [stops[0]!, stops[stops.length - 1]!] }
    }
    const ancestorChain = (element: HTMLElement) => {
      const ancestors: HTMLElement[] = []
      for (
        let node: HTMLElement | null = element;
        node;
        node = node.parentElement
      )
        ancestors.unshift(node)
      return ancestors
    }
    const unsupportedBackdrop = (
      element: HTMLElement,
      ancestors: HTMLElement[]
    ) =>
      ancestors.some(
        (node) =>
          Number(getComputedStyle(node).opacity) !== 1 ||
          (node !== element &&
            getComputedStyle(node).backgroundImage !== "none")
      )
    const textColors = (element: HTMLElement) => {
      const colors = new Map<string, string>()
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim()
        const parent = node.parentElement
        if (text && parent && !parent.closest('[aria-hidden="true"]'))
          colors.set(text, getComputedStyle(parent).color)
      }
      return colors
    }
    const baseColor = (ancestors: HTMLElement[]) => {
      context.clearRect(0, 0, 1, 1)
      paint("white")
      for (const node of ancestors)
        paint(getComputedStyle(node).backgroundColor)
      return `rgb(${pixel().join(",")})`
    }
    const labelSamples = (
      id: string,
      gradient: string,
      base: string,
      endpoints: string[],
      colors: Map<string, string>
    ) => {
      const values: Sample[] = []
      for (const endpoint of endpoints)
        for (const [text, foreground] of colors) {
          context.clearRect(0, 0, 1, 1)
          paint(base)
          paint(endpoint)
          const background = luminance(pixel())
          paint(foreground)
          const renderedText = luminance(pixel())
          values.push({
            id,
            text,
            gradient,
            endpoint,
            foreground,
            base,
            ratio:
              (Math.max(background, renderedText) + 0.05) /
              (Math.min(background, renderedText) + 0.05),
          })
        }
      return values
    }
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-slot="button"]'
    )) {
      const style = getComputedStyle(element)
      if (style.backgroundImage === "none") continue
      if (
        element.matches(':disabled,[aria-disabled="true"],[data-disabled]') &&
        element.getAttribute("aria-busy") !== "true"
      ) {
        inactiveExcluded++
        continue
      }
      const text = element.textContent?.trim()
      if (!text) continue
      const id = element.id || text
      const gradient = gradientEndpoints(style.backgroundImage)
      if (gradient.reason) {
        incomplete.push({ id, reason: gradient.reason })
        continue
      }
      const ancestors = ancestorChain(element)
      if (unsupportedBackdrop(element, ancestors)) {
        incomplete.push({
          id,
          reason: "Ancestor opacity or image requires pixel-level review",
        })
        continue
      }
      samples.push(
        ...labelSamples(
          id,
          style.backgroundImage,
          baseColor(ancestors),
          gradient.endpoints!,
          textColors(element)
        )
      )
    }
    return {
      samples,
      incomplete,
      inactiveExcluded,
      scope:
        "Computed gradient endpoints composited over the actual CSS base; excludes inactive controls. This does not sample every interpolation pixel.",
    }
  })
  await info.attach("gradient-endpoint-contrast", {
    body: JSON.stringify(result, null, 2),
    contentType: "application/json",
  })
  expect(
    result.samples.length,
    "Rendered gradient labels must actually be checked"
  ).toBeGreaterThan(0)
  expect(
    result.incomplete,
    "Unsupported backgrounds require manual review; no clean gradient claim is possible"
  ).toEqual([])
  expect(
    result.samples.filter((sample) => sample.ratio < 4.5),
    "Gradient endpoint text contrast must meet4.5:1"
  ).toEqual([])
})
