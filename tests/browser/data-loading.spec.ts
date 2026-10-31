import { expect, test } from "@playwright/test"

for (const theme of ["light", "dark"] as const) {
  test(`Skullet keeps pending files inert and reveals an empty result in ${theme} mode`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" })
    await page.addInitScript(() => {
      localStorage.setItem("durable-pi:activity-motion", "off")
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route("**/api/agent/files?**", async (route) => {
      await held
      await route.fulfill({ json: { files: [] } })
    })
    await page.goto("/agents/navi/files")
    await page
      .getByLabel("Email", { exact: true })
      .fill("browser-smoke@example.invalid")
    await page
      .getByLabel("Password", { exact: true })
      .fill("Disposable browser fixture password 2026!")
    await page.getByRole("button", { name: "Sign in", exact: true }).click()
    const loading = page
      .locator('.data-loading[aria-busy="true"]')
      .filter({ has: page.getByText("Loading files", { exact: true }) })
    await expect(loading).toBeVisible()
    await expect(loading.locator("[inert][aria-hidden=true]")).toHaveCount(1)
    await expect
      .poll(() => loading.locator("[skullet-rect]").count())
      .toBeGreaterThan(0)
    await expect(loading.getByRole("button")).toHaveCount(0)
    await expect(page.getByText("No files yet", { exact: true })).toHaveCount(0)
    expect(
      await loading.evaluate(
        (node) =>
          node
            .getAnimations({ subtree: true })
            .filter((animation) => animation.playState === "running").length
      )
    ).toBe(0)
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth
      )
    ).toBe(true)
    release()
    await expect(loading).toHaveCount(0)
    await expect(page.getByText("No files yet", { exact: true })).toBeVisible()
    expect(errors).toEqual([])
  })
}
