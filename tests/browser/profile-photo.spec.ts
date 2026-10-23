import { expect, test } from "@playwright/test"

test("upload, reload, replace and remove a profile photo", async ({
  page,
  baseURL,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let image: string | null = null
  let saved: Buffer | null = null
  let uploads = 0
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGOQr5j47s4qAAqJA53yuzs5AAAAAElFTkSuQmCC",
    "base64"
  )
  await page.route("**/api/auth/get-session**", async (route) => {
    const response = await route.fetch()
    const session = await response.json()
    if (session?.user) session.user.image = image
    await route.fulfill({ response, json: session })
  })
  await page.route("**/api/account/avatar**", async (route) => {
    const request = route.request()
    if (request.method() === "GET") {
      expect(request.url()).toBe(image)
      await route.fulfill({ contentType: "image/webp", body: saved! })
      return
    }
    if (request.method() === "POST") {
      expect(request.headers()["content-type"]).toBe("image/webp")
      saved = request.postDataBuffer()!
      expect(saved.length).toBeLessThan(1024 * 1024)
      image = `${baseURL}/api/account/avatar?v=${crypto.randomUUID()}`
      uploads++
    } else {
      expect(request.method()).toBe("DELETE")
      saved = null
      image = null
    }
    await route.fulfill({ json: { image } })
  })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Your agents" })).toBeVisible()
  await page.goto("/settings/account")
  await expect(
    page.getByRole("heading", { name: "Account", exact: true })
  ).toBeVisible()
  await expect(page.locator(".workspace-settings .agent-mark")).toHaveCount(0)
  await expect(
    page.locator(".workspace-settings").getByRole("button", {
      name: "Edit agent",
      exact: true,
      includeHidden: true,
    })
  ).toHaveCount(0)
  const photo = page.getByRole("region", {
    name: "Your profile photo",
    exact: true,
  })
  const input = page.getByLabel("Choose a photo", { exact: true })
  const remove = photo.getByRole("button", {
    name: "Remove photo",
    exact: true,
  })
  await expect(remove).toBeDisabled()
  await input.setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  })
  await expect(photo.getByRole("status")).toHaveText("Profile photo updated.")
  await expect(photo.locator("img")).toHaveJSProperty("naturalWidth", 512)
  const first = image
  await page.reload()
  await expect(photo.locator("img")).toHaveAttribute("src", first!)
  await expect(photo.locator("img")).toHaveJSProperty("naturalHeight", 512)
  await input.setInputFiles({
    name: "invalid.svg",
    mimeType: "image/svg+xml",
    buffer: Buffer.from("<svg/>"),
  })
  await expect(photo.getByRole("alert")).toContainText(
    "Choose a JPEG, PNG or WebP image."
  )
  expect(uploads).toBe(1)
  await expect(photo.locator("img")).toHaveAttribute("src", first!)
  await input.setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: png,
  })
  await expect(photo.getByRole("status")).toHaveText("Profile photo updated.")
  expect(image).not.toBe(first)
  await expect(photo.locator("img")).toHaveJSProperty("naturalWidth", 512)
  const dimensions = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    viewport: innerWidth,
  }))
  expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport)
  await page.screenshot({
    path: test.info().outputPath("profile-photo.png"),
    animations: "disabled",
  })
  await remove.click()
  await expect(photo.getByRole("status")).toHaveText("Profile photo removed.")
  await expect(photo.locator("img")).toHaveCount(0)
  await expect(remove).toBeDisabled()
  await page.reload()
  await expect(remove).toBeDisabled()
  await expect(photo.locator('[data-slot="avatar-fallback"]')).toHaveText("B")
  expect(errors).toEqual([])
})
