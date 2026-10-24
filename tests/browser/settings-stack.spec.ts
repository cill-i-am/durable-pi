import { expect, test, type Page } from "@playwright/test"

import { closeSettings, settingsFrame, settingsFront } from "./settings-helpers"

async function signIn(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
}

async function expectStack(page: Page, paths: readonly string[]) {
  await expect
    .poll(() =>
      page
        .locator("[data-settings-route]")
        .evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("data-settings-route"))
        )
    )
    .toEqual(paths)
  for (const [index, path] of paths.entries()) {
    await expect(settingsFrame(page, path)).toHaveAttribute(
      "data-overlay-mobile",
      "true"
    )
    await expect(settingsFrame(page, path)).toHaveAttribute(
      "data-settings-frontmost",
      String(index === paths.length - 1)
    )
  }
  await expect.poll(() => new URL(page.url()).pathname).toBe(paths.at(-1))
  expect(new URL(page.url()).searchParams.has("settingsView")).toBe(false)
}

async function expectRootFocus(page: Page) {
  try {
    const target = page.locator("#main-content:focus, #main-content :focus")
    await expect(target).toBeVisible()
    await expect(target).toBeEnabled()
    await expect
      .poll(() =>
        target.evaluate(
          (node) =>
            !node.closest('[aria-hidden="true"], [inert], [data-base-ui-inert]')
        )
      )
      .toBe(true)
  } catch (error) {
    const state = await page.evaluate(() => {
      const describe = (node: Element) => ({
        tag: node.tagName,
        id: node.id,
        role: node.getAttribute("role"),
        hidden: node.getAttribute("aria-hidden"),
        inert: node.hasAttribute("inert"),
        nativeInert: node.hasAttribute("data-base-ui-inert"),
        route: node.getAttribute("data-settings-route"),
        open: node.hasAttribute("data-open"),
        closed: node.hasAttribute("data-closed"),
      })
      return {
        active: document.activeElement?.outerHTML.slice(0, 1500),
        main: document.getElementById("main-content")?.outerHTML.slice(0, 1500),
        portals: [...document.querySelectorAll("[data-base-ui-portal]")].map(
          describe
        ),
        hidden: [
          ...document.querySelectorAll(
            '[aria-hidden="true"], [inert], [data-base-ui-inert]'
          ),
        ]
          .filter((node) => node.tagName !== "svg")
          .map(describe),
      }
    })
    await test.info().attach("root-focus-dom", {
      body: JSON.stringify(state, null, 2),
      contentType: "application/json",
    })
    throw error
  }
}

async function swipeDown(page: Page) {
  const handle = settingsFront(page).locator(".responsive-overlay-handle")
  const bounds = await handle.boundingBox()
  expect(bounds).not.toBeNull()
  const x = bounds!.x + bounds!.width / 2
  const y = bounds!.y + bounds!.height / 2
  const session = await page.context().newCDPSession(page)
  try {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    })
    for (let step = 1; step <= 8; step++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: y + step * 45 }],
      })
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    })
  } finally {
    await session.detach()
  }
}

test("personal and agent settings indexes open their own navigation without selecting a detail", async ({
  page,
}) => {
  await signIn(page)
  for (const [path, title, rows] of [
    [
      "/settings",
      "Settings",
      [
        "Account",
        "Preferences",
        "Account security",
        "Connections",
        "Skills",
        "Channels",
        "Family",
        "Model access",
      ],
    ],
    [
      "/agents/navi/settings",
      "Agent settings",
      ["General", "Models", "Connections", "Tool access", "Skills"],
    ],
  ] as const) {
    await page.goto(path)
    await expect.poll(() => new URL(page.url()).pathname).toBe(path)
    const index = settingsFront(page)
    await expect(index).toHaveAttribute("data-settings-route", path)
    await expect(index).toHaveAttribute("data-settings-index", "true")
    await expect(
      index.getByRole("heading", { name: title, exact: true })
    ).toBeVisible()
    await expect(
      index
        .getByRole("navigation", { name: "Settings sections", exact: true })
        .getByRole("link")
    ).toHaveText([...rows])
    await expect(
      index.getByRole("heading", { name: /^(Account|General)$/, exact: true })
    ).toHaveCount(0)
    await expect(
      index.getByRole("button", { name: "Close settings", exact: true })
    ).toBeEnabled()
  }
  await page.goto("/agents/navi")
  await page
    .getByRole("button", { name: "Agent settings and tools", exact: true })
    .click()
  await page
    .getByRole("menuitem", { name: "Agent settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi\/settings$/)
  await expect(
    settingsFront(page).getByRole("heading", {
      name: "Agent settings",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    settingsFront(page).getByRole("link", { name: "General", exact: true })
  ).toBeVisible()
})

test("mobile settings keep native parents mounted and restore the originating control for each dismissal", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Native mobile drawer stack")
  await signIn(page)
  await page
    .getByRole("region", { name: "Your agents" })
    .getByRole("link", { name: "Navi", exact: true })
    .click()
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
    includeHidden: true,
  })
  await composer.fill("Keep this local draft through the settings stack.")
  const originalComposer = await composer.elementHandle()
  await page
    .getByRole("navigation", { name: "Mobile workspace", exact: true })
    .getByRole("button", { name: "Agents", exact: true })
    .click()
  await page
    .getByRole("navigation", { name: "Agents and workspace", exact: true })
    .getByRole("button", { name: "Settings for Bench", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Settings", exact: true }).click()
  await expectStack(page, ["/settings"])
  await expect(
    page.locator('[data-slot="sidebar"][data-mobile="true"]')
  ).toHaveCount(0)
  await expect(
    settingsFront(page).getByRole("heading", { name: "Settings", exact: true })
  ).toBeVisible()
  await expect(
    settingsFront(page).getByRole("heading", { name: "Account", exact: true })
  ).toHaveCount(0)
  const root = await settingsFrame(page, "/settings").elementHandle()
  const familyRow = settingsFront(page).getByRole("link", {
    name: "Family",
    exact: true,
  })
  await familyRow.click()
  await expectStack(page, ["/settings", "/family"])
  const family = await settingsFrame(page, "/family").elementHandle()
  const modelAccess = settingsFrame(page, "/family").getByRole("button", {
    name: "Model access",
    exact: true,
  })
  for (const dismissal of ["Close Model access", "Escape", "Back to Family"]) {
    await modelAccess.click()
    await expectStack(page, ["/settings", "/family", "/family/model-access"])
    expect(await root!.evaluate((node) => node.isConnected)).toBe(true)
    expect(await family!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(
      page.getByRole("heading", { name: "Family", exact: true })
    ).toHaveCount(0)
    await expect(
      settingsFront(page).getByRole("heading", {
        name: "Model access",
        exact: true,
      })
    ).toBeVisible()
    if (dismissal === "Escape") await page.keyboard.press("Escape")
    else
      await settingsFront(page)
        .getByRole("button", { name: dismissal, exact: true })
        .click()
    await expectStack(page, ["/settings", "/family"])
    await expect(modelAccess).toBeFocused()
  }
  await settingsFront(page)
    .getByRole("button", { name: "Back to Settings", exact: true })
    .click()
  await expectStack(page, ["/settings"])
  await expect(familyRow).toBeFocused()
  expect(await root!.evaluate((node) => node.isConnected)).toBe(true)
  await settingsFront(page)
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
  await expect(page.locator("[data-settings-route]")).toHaveCount(0)
  expect(await originalComposer!.evaluate((node) => node.isConnected)).toBe(
    true
  )
  await expect(composer).toBeVisible()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeVisible()
  await expect(composer).toHaveValue(
    "Keep this local draft through the settings stack."
  )
  await expectRootFocus(page)
})

test("a native downward swipe dismisses only the top mobile settings route", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Touch gesture dismissal")
  await signIn(page)
  await page.goto("/family?returnTo=%2Fagents%2Fnavi")
  await expectStack(page, ["/settings", "/family"])
  const family = await settingsFrame(page, "/family").elementHandle()
  const modelAccess = settingsFront(page).getByRole("button", {
    name: "Model access",
    exact: true,
  })
  await modelAccess.click()
  await expectStack(page, ["/settings", "/family", "/family/model-access"])
  await swipeDown(page)
  await expectStack(page, ["/settings", "/family"])
  expect(await family!.evaluate((node) => node.isConnected)).toBe(true)
  await expect(modelAccess).toBeFocused()
  await swipeDown(page)
  await expectStack(page, ["/settings"])
  await expect(
    settingsFront(page).getByRole("link", { name: "Family", exact: true })
  ).toBeFocused()
})

test("mobile agent Models retains its parent across global Model access history and reload", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Cross-scope mobile stack")
  await signIn(page)
  await page.goto("/agents/navi/settings")
  await expectStack(page, ["/agents/navi/settings"])
  await settingsFront(page)
    .getByRole("link", { name: "Models", exact: true })
    .click()
  await expectStack(page, [
    "/agents/navi/settings",
    "/agents/navi/settings/models",
  ])
  const models = await settingsFrame(
    page,
    "/agents/navi/settings/models"
  ).elementHandle()
  const modelAccess = settingsFront(page).getByRole("button", {
    name: "Model access",
    exact: true,
  })
  await modelAccess.click()
  const paths = [
    "/agents/navi/settings",
    "/agents/navi/settings/models",
    "/family/model-access",
  ]
  await expectStack(page, paths)
  await expect(settingsFront(page)).toHaveAttribute(
    "data-settings-scope",
    "personal"
  )
  await expect(settingsFront(page).locator(".agent-mark")).toHaveCount(0)
  expect(await models!.evaluate((node) => node.isConnected)).toBe(true)
  await page.goBack()
  await expectStack(page, paths.slice(0, 2))
  await expect(modelAccess).toBeFocused()
  await page.goForward()
  await expectStack(page, paths)
  await page.reload()
  await expectStack(page, paths)
  await expect(
    settingsFront(page).getByRole("button", {
      name: "Back to Models",
      exact: true,
    })
  ).toBeEnabled()
  await settingsFront(page)
    .getByRole("button", { name: "Back to Models", exact: true })
    .click()
  await expectStack(page, paths.slice(0, 2))
  await expect(
    settingsFront(page).getByRole("heading", { name: "Models", exact: true })
  ).toBeVisible()
  await settingsFront(page)
    .getByRole("button", { name: "Close Models", exact: true })
    .click()
  await expectStack(page, paths.slice(0, 1))
})

test("mobile settings retain the closing page until the native exit transition completes", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Native exit lifecycle")
  await signIn(page)
  await page.goto("/settings/account?returnTo=%2Fagents%2Fnavi")
  await expectStack(page, ["/settings", "/settings/account"])
  const account = await settingsFrame(page, "/settings/account").elementHandle()
  await account!.evaluate((node) => {
    const observed = { ending: false, connected: false, retained: false }
    Object.assign(window, { settingsExit: observed })
    const observer = new MutationObserver(() => {
      if (!node.hasAttribute("data-ending-style")) return
      observed.ending = true
      observed.connected = node.isConnected
      observed.retained = !!node.querySelector('input[type="file"]')
      observer.disconnect()
    })
    observer.observe(node, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
    })
  })
  await settingsFront(page)
    .getByRole("button", { name: "Close Account", exact: true })
    .click()
  await expectStack(page, ["/settings"])
  expect(
    await page.evaluate(
      () => (window as unknown as { settingsExit: unknown }).settingsExit
    )
  ).toEqual({ ending: true, connected: true, retained: true })
  expect(await account!.evaluate((node) => node.isConnected)).toBe(false)
  await settingsFront(page).evaluate((node) => {
    const observed = { ending: false, connected: false, path: "" }
    Object.assign(window, { settingsRootExit: observed })
    const observer = new MutationObserver(() => {
      if (!node.hasAttribute("data-ending-style")) return
      observed.ending = true
      observed.connected = node.isConnected
      observed.path = window.location.pathname
      observer.disconnect()
    })
    observer.observe(node, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
    })
  })
  await settingsFront(page)
    .getByRole("button", { name: "Close settings", exact: true })
    .click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
  await expect(page.locator("[data-settings-route]")).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { settingsRootExit: unknown }).settingsRootExit
    )
  ).toEqual({ ending: true, connected: true, path: "/settings" })
  await expectRootFocus(page)
})

test("a dirty settings form keeps the same native body across portrait and landscape", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile viewport crossing")
  let writes = 0
  await page.route("**/api/agent/model-account?*", (route) => {
    if (route.request().method() !== "GET") {
      writes++
      return route.fulfill({
        status: 500,
        json: { error: "Unexpected mutation" },
      })
    }
    return route.fulfill({
      json: {
        pending: {
          id: "resize-draft",
          email: "browser-smoke@example.invalid",
          expiresAt: Date.now() + 600_000,
          authorizationUrl: "https://example.invalid/synthetic-sign-in",
        },
      },
    })
  })
  await signIn(page)
  await page.goto("/family/model-access?returnTo=%2Fagents%2Fnavi")
  const field = page.getByLabel("Return address", { exact: true })
  const draft =
    "http://127.0.0.1:53000/auth/callback?code=synthetic-resize-code&state=synthetic-resize-state"
  await field.fill(draft)
  const body = await settingsFrame(page, "/family/model-access").elementHandle()
  const original = await field.elementHandle()
  for (const viewport of [
    { width: 844, height: 390 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport)
    expect(await body!.evaluate((node) => node.isConnected)).toBe(true)
    expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
    await expect(field).toHaveCount(1)
    await expect(field).toBeVisible()
    await expect(field).toHaveValue(draft)
    await expect(settingsFront(page)).toHaveAttribute(
      "data-overlay-mobile",
      String(viewport.width < 768)
    )
    await page.keyboard.press("Escape")
    await expect(page).toHaveURL(/\/family\/model-access\?returnTo=/)
    await expect(field).toHaveValue(draft)
    const size = await page.evaluate(() => ({
      content: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }))
    expect(size.content).toBeLessThanOrEqual(size.viewport)
    const bounds = await field.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width)
  }
  expect(writes).toBe(0)
  await settingsFront(page)
    .getByRole("button", { name: "Discard return address", exact: true })
    .click()
  await closeSettings(page)
  await expect(page).toHaveURL(/\/agents\/navi$/)
  await expectRootFocus(page)
  expect(writes).toBe(0)
})

test("browser Back retains an agent-backed settings page through its native exit to the collection", async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, "Mobile owner exit lifetime")
  await signIn(page)
  // A same-document deep link enters through native browser history, without
  // inventing app stack metadata or navigating to a second document.
  await page.evaluate(() =>
    window.history.pushState(
      {},
      "",
      "/settings/account?returnTo=%2Fagents%2Fnavi"
    )
  )
  await expect(
    settingsFront(page).getByRole("heading", { name: "Account", exact: true })
  ).toBeVisible()
  const account = await settingsFrame(page, "/settings/account").elementHandle()
  await account!.evaluate((node) => {
    const observed = { ending: false, retained: false }
    Object.assign(window, { settingsBackExit: observed })
    const observer = new MutationObserver(() => {
      if (!node.hasAttribute("data-ending-style")) return
      observed.ending = true
      observed.retained =
        node.isConnected && !!node.querySelector('input[type="file"]')
      observer.disconnect()
    })
    observer.observe(node, {
      attributes: true,
      attributeFilter: ["data-ending-style"],
    })
  })
  await page.goBack()
  await expect(page).toHaveURL(/\/agents$/)
  await expect(page.locator("[data-settings-route]")).toHaveCount(0)
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { settingsBackExit: unknown }).settingsBackExit
    )
  ).toEqual({ ending: true, retained: true })
  expect(await account!.evaluate((node) => node.isConnected)).toBe(false)
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await expectRootFocus(page)
})
