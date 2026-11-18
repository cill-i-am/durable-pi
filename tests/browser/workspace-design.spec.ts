import { expect, test, type Page } from "@playwright/test"

import { closeSettings, settingsFront } from "./settings-helpers"

async function signIn(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
}

async function openSettings(page: Page, mobile: boolean) {
  if (mobile)
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click()
  await page
    .getByRole("button", { name: "Account menu for Bench", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expect(settingsFront(page)).toBeVisible()
}

test("assistant action targets stay distinct and centered in compact sidebar rows", async ({
  page,
  isMobile,
}) => {
  const name =
    "Navi — planning family holidays, meals and everything in between"
  await page.route("**/api/agent/bots", async (route) => {
    const response = await route.fetch()
    const body = await response.json()
    await route.fulfill({
      response,
      json: {
        ...body,
        agents: body.agents.map((agent: { name: string }) => ({
          ...agent,
          name,
        })),
      },
    })
  })
  await signIn(page)
  await page.goto("/agents/navi")
  if (isMobile)
    await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  const action = page.getByRole("button", {
    name: `Actions for ${name}`,
    exact: true,
  })
  const row = page
    .locator('[data-slot="sidebar-menu-item"]')
    .filter({ has: action })
  for (const width of isMobile ? [390, 320] : [1280, 800, 768]) {
    await page.setViewportSize({ width, height: 900 })
    await row.hover()
    const target = (await action.boundingBox())!
    const container = (await row.boundingBox())!
    expect(target.width).toBeGreaterThanOrEqual(24)
    expect(target.height).toBeGreaterThanOrEqual(24)
    const label = (await row
      .locator('[data-slot="sidebar-menu-button"] > span:last-child')
      .boundingBox())!
    expect(label.x + label.width).toBeLessThanOrEqual(target.x - 4)
    expect(
      Math.abs(
        target.y + target.height / 2 - container.y - container.height / 2
      ),
      JSON.stringify({ target, container })
    ).toBeLessThan(1)
    await page.mouse.click(
      target.x + target.width / 2 - 11,
      target.y + target.height / 2
    )
    const menu = page.getByRole("menu", {
      name: `Actions for ${name}`,
      exact: true,
    })
    await expect(menu).toBeVisible()
    await expect(page).toHaveURL(/\/agents\/navi$/)
    await menu.press("Escape")
    await expect(action).toBeFocused()
  }
})

test("settings after hiding a retained workbench keep it closed and return to the same draft", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  await page.goto("/agents/navi")
  await expect(
    page.getByRole("button", {
      name: /^(toggle|collapse|expand|close) sidebar$/i,
    })
  ).toHaveCount(1)
  if (!isMobile) {
    await page.addStyleTag({
      content: `
        @keyframes hold-workbench-close { from { opacity: 1; } to { opacity: 0; } }
        .workbench-sheet[data-ending-style] { animation: hold-workbench-close 30s linear; }
      `,
    })
  }
  const draft = page.getByRole("textbox", { name: "Message Navi", exact: true })
  await draft.fill("Keep this private conversation draft")
  await page
    .getByRole("button", { name: "Open workbench", exact: true })
    .click()
  if (isMobile)
    await expect(
      page.getByRole("button", { name: "Close Files tab", exact: true })
    ).toBeVisible()
  else
    await expect(
      page.getByRole("tab", { name: "Files", exact: true })
    ).toBeVisible()
  await page
    .getByRole("button", { name: "Hide workbench", exact: true })
    .click()
  if (!isMobile)
    await expect(
      page.locator(".workbench-sheet[data-ending-style]")
    ).toHaveCount(1)
  await expect(draft).toBeVisible()
  await openSettings(page, isMobile)
  await expect(page.locator('.workbench-host[data-open="true"]')).toHaveCount(0)
  if (!isMobile) {
    // Settings opens while native CLOSED is still withheld, not after it.
    await expect(
      page.locator(".workbench-sheet[data-ending-style]")
    ).toHaveCount(1)
    await page.evaluate(() =>
      document.getAnimations().forEach((animation) => {
        if (
          animation instanceof CSSAnimation &&
          animation.animationName === "hold-workbench-close"
        )
          animation.finish()
      })
    )
    await expect(page.locator(".workbench-sheet")).toBeHidden()
  }
  await closeSettings(page)
  await expect(draft).toHaveValue("Keep this private conversation draft")
  await expect(draft).toBeVisible()
  await expect(page.locator('.workbench-host[data-open="true"]')).toHaveCount(0)
})

test("device animation preference reaches shared controls and native overlay CSS", async ({
  page,
  isMobile,
}) => {
  await signIn(page)
  if (!isMobile) {
    await page
      .getByRole("button", { name: "Toggle Sidebar", exact: true })
      .click()
    await expect(
      page.getByRole("button", { name: "Account menu for Bench", exact: true })
    ).toBeVisible()
  }
  await openSettings(page, isMobile)
  await settingsFront(page)
    .getByRole("link", { name: "Preferences", exact: true })
    .click()
  const control = page.getByRole("switch", {
    name: "Interface animations",
    exact: true,
  })
  await expect(control).toBeChecked()
  await control.click()
  await expect(control).not.toBeChecked()
  await expect(page.locator("html")).toHaveAttribute(
    "data-ui-motion",
    "reduced"
  )
  await expect
    .poll(() =>
      page
        .locator("[data-settings-frontmost=true]")
        .evaluate((node) =>
          Math.max(
            ...getComputedStyle(node)
              .transitionDuration.split(",")
              .map(Number.parseFloat)
          )
        )
    )
    .toBeLessThan(0.001)
  await control.click()
  await expect(page.locator("html")).toHaveAttribute("data-ui-motion", "full")
})

test("the inset frame stays outside the sidebar in expanded and icon states", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop inset frame")
  await page.setViewportSize({ width: 1456, height: 853 })
  await signIn(page)
  await page.goto("/agents/navi")
  const toggle = page.getByRole("button", {
    name: "Toggle Sidebar",
    exact: true,
  })
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme
    )
    for (const state of ["expanded", "collapsed"] as const) {
      const sidebar = page.locator(
        '[data-slot="sidebar"][data-variant="inset"]'
      )
      if ((await sidebar.getAttribute("data-state")) !== state)
        await toggle.click()
      await expect(sidebar).toHaveAttribute("data-state", state)
      await page.locator('[data-slot="sidebar-gap"]').evaluate(async (node) => {
        getComputedStyle(node).width
        await Promise.allSettled(
          node.getAnimations().map((animation) => animation.finished)
        )
      })
      const metrics = () =>
        page.evaluate(() => {
          const frame = document.querySelector(".workspace-main")!
          const sidebar = document.querySelector(
            '.workspace-sidebar[data-slot="sidebar-container"]'
          )!
          const style = getComputedStyle(frame)
          return {
            left: frame.getBoundingClientRect().left,
            sidebarRight: sidebar.getBoundingClientRect().right,
            edgeClear: !!document
              .elementFromPoint(
                frame.getBoundingClientRect().left + 0.5,
                frame.getBoundingClientRect().top +
                  frame.getBoundingClientRect().height / 2
              )
              ?.closest(".workspace-main"),
            border: style.borderLeftWidth,
            radius: style.borderTopLeftRadius,
          }
        })
      await expect
        .poll(async () => {
          const m = await metrics()
          return m.sidebarRight <= m.left
        })
        .toBe(true)
      const m = await metrics()
      expect(m.edgeClear).toBe(true)
      expect(m.border).toBe("1px")
      expect(parseFloat(m.radius)).toBeGreaterThan(0)
      if (theme === "dark" && state === "collapsed")
        await page.screenshot({
          path: "test-results/inset-frame-collapsed.png",
          animations: "disabled",
        })
    }
  }
})
