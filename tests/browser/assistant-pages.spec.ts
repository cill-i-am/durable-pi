import { expect, test, type Page } from "@playwright/test"

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

const returnTo = "/agents/navi/files?tab=trash"

for (const [path, title] of [
  ["new", "New assistant"],
  ["navi/edit", "Edit assistant"],
] as const) {
  test(`${title} retains its actual fields between desktop page and mobile drawer and cancels safely`, async ({
    page,
    isMobile,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" })
    await signIn(page)
    await page.goto(`/agents/${path}?${new URLSearchParams({ returnTo })}`)
    const editor = page.locator(".assistant-editor-sheet")
    await expect(editor).toHaveAttribute("role", isMobile ? "dialog" : "region")
    await expect(
      editor.getByRole("heading", { name: title, exact: true })
    ).toBeVisible()
    const name = editor.getByLabel("Name", { exact: true })
    const purpose = editor.getByLabel("Purpose", { exact: true })
    await name.fill("Travel planner draft")
    await purpose.fill("Keep this purpose while changing the window size.")
    const originalName = await name.elementHandle()
    const originalPurpose = await purpose.elementHandle()
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
      { width: 390, height: 430 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport)
      const mobile = viewport.width < 768
      await expect(editor).toHaveAttribute("role", mobile ? "dialog" : "region")
      await expect(name).toHaveValue("Travel planner draft")
      await expect(purpose).toHaveValue(
        "Keep this purpose while changing the window size."
      )
      expect(
        await originalName!.evaluate(
          (node) =>
            node.isConnected && node === document.getElementById("agent-name")
        )
      ).toBe(true)
      expect(
        await originalPurpose!.evaluate(
          (node) =>
            node.isConnected &&
            node === document.getElementById("agent-instructions")
        )
      ).toBe(true)
      if (mobile) {
        await expect(
          editor.getByRole("button", { name: "Close sheet", exact: true })
        ).toBeVisible()
        // Base UI's modal focus manager hides the background rather than
        // emitting aria-modal. Check its observable accessibility boundary.
        await expect(
          page.getByRole("button", { name: "All assistants", exact: true })
        ).toHaveCount(0)
        await expect(name).toBeVisible()
        await expect(purpose).toBeVisible()
        await editor
          .getByRole("button", { name: "Close sheet", exact: true })
          .focus()
        await page.keyboard.press("Tab")
        await expect(name).toBeFocused()
        await expect(name).toHaveCSS("font-size", "16px")
        await expect(purpose).toHaveCSS("font-size", "16px")
        await expect(
          editor.getByRole("button", { name: "Cancel", exact: true })
        ).toHaveCount(0)
        await expect(
          editor.locator('[data-slot="card-frame-footer"] button:visible')
        ).toHaveCount(1)
        await expect(
          editor.locator('[data-slot="card-frame-footer"] button:visible')
        ).toBeInViewport()
      } else {
        expect(
          await editor.evaluate((node) => !!node.closest("#main-content"))
        ).toBe(true)
        await expect(editor).toHaveCSS("position", "relative")
        const inset = await page.locator("#main-content").boundingBox()
        const header = await editor
          .locator(".assistant-editor-header")
          .boundingBox()
        expect(header!.y - inset!.y).toBeLessThan(2)
        await expect(
          editor.getByRole("button", { name: "Cancel", exact: true })
        ).toBeInViewport()
        await expect(editor).not.toHaveAttribute("aria-modal", "true")
        await expect(page.locator('[data-slot="sheet-overlay"]')).toHaveCount(0)
        await expect(
          editor.getByRole("button", { name: "Close sheet", exact: true })
        ).toHaveCount(0)
        await page.keyboard.press("Escape")
        await expect(editor).toBeVisible()
      }
    }
    await editor.getByRole("button", { name: "Cancel", exact: true }).click()
    await expect(page).toHaveURL(new RegExp(`/agents/navi/files\\?tab=trash$`))
    await expect(editor).toHaveCount(0)
    await expect(
      page.getByRole("tab", { name: "Files", exact: true })
    ).toBeVisible()
  })
}

test("an uncertain assistant save retains its immutable request and newer draft through rotation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await signIn(page)
  const { agents } = await (await page.request.get("/api/agent/bots")).json()
  const profile = agents[0]
  const writes: unknown[] = []
  await page.route("**/api/agent/bots/update", async (route) => {
    const payload = route.request().postDataJSON() as {
      id: string
      name: string
      instructions: string
    }
    writes.push(payload)
    if (writes.length === 1) {
      await route.fulfill({
        status: 503,
        json: {
          error: "Save acknowledgement unavailable. Retry the same request.",
        },
      })
    } else {
      await route.fulfill({ json: { ...profile, ...payload } })
    }
  })
  await page.goto(
    `/agents/navi/edit?${new URLSearchParams({ returnTo: "/agents/navi" })}`
  )
  const editor = page.locator(".assistant-editor-sheet")
  const name = editor.getByLabel("Name", { exact: true })
  await name.fill("First saved name")
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect(editor.getByRole("alert")).toContainText(
    "Retry the same request"
  )
  await name.fill("Newer unsaved name")
  const original = await name.elementHandle()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(editor).toHaveAttribute("role", "dialog")
  await page.setViewportSize({ width: 1280, height: 900 })
  await expect(editor).toHaveAttribute("role", "region")
  expect(await original!.evaluate((node) => node.isConnected)).toBe(true)
  expect(writes).toHaveLength(1)
  await editor
    .getByRole("button", { name: "Save changes", exact: true })
    .click()
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual(writes[0])
  await expect(name).toHaveValue("Newer unsaved name")
  await expect(
    editor.getByRole("button", { name: "Save changes", exact: true })
  ).toBeEnabled()
  await editor.getByRole("button", { name: "Cancel", exact: true }).click()
  await expect(page).toHaveURL(/\/agents\/navi$/)
})
