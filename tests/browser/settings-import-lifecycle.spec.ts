import { expect, test, type Page } from "@playwright/test"

async function signIn(page: Page, path: string) {
  await page.goto(path)
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Sign in", exact: true })
  ).toBeHidden()
}
for (const channel of ["email", "whatsapp"] as const) {
  test(`${channel} restores an uncertain immutable request after reload without dispatching it`, async ({
    page,
  }) => {
    const bodies: unknown[] = []
    const view =
      channel === "email"
        ? {
            configured: true,
            enabled: false,
            revision: 0,
            address: null,
            messages: [],
          }
        : {
            configured: true,
            enabled: false,
            revision: 0,
            agentId: "home",
            agentName: "Navi",
            contactUrl: null,
            messages: [],
          }
    await page.route(`**/api/agent/${channel}**`, async (route) => {
      if (route.request().method() !== "POST")
        return route.fulfill({ json: view })
      bodies.push(route.request().postDataJSON())
      return route.fulfill(
        bodies.length === 1
          ? {
              status: 503,
              json: { error: "The save response was not confirmed." },
            }
          : { json: { ...view, enabled: true, revision: 1 } }
      )
    })
    await signIn(
      page,
      channel === "email"
        ? "/agents/home/settings/general"
        : "/settings/channels"
    )
    await page
      .getByRole("button", {
        name: channel === "email" ? "Enable email" : "Enable WhatsApp",
        exact: true,
      })
      .click()
    await expect(
      page.getByRole("button", { name: "Retry same request", exact: true })
    ).toBeVisible()
    expect(bodies).toHaveLength(1)
    await page.reload()
    await expect(
      page.getByRole("button", { name: "Retry same request", exact: true })
    ).toBeVisible()
    expect(bodies).toHaveLength(1)
    await page
      .getByRole("button", { name: "Retry same request", exact: true })
      .click()
    await expect.poll(() => bodies.length).toBe(2)
    expect(bodies[1]).toEqual(bodies[0])
    await expect(
      page.getByRole("button", { name: "Retry same request", exact: true })
    ).toBeHidden()
  })
}

test("Memory import admits one immutable file read and submission", async ({
  page,
}) => {
  const bodies: unknown[] = []
  await page.route("**/api/agent/import?**", async (route) => {
    bodies.push(route.request().postDataJSON())
    await route.fulfill(
      bodies.length === 1
        ? {
            status: 503,
            json: { error: "Import response unavailable." },
          }
        : { json: { added: 1 } }
    )
  })
  await signIn(page, "/agents/home/memory")
  await page.getByRole("tab", { name: "Archive", exact: true }).click()
  const jsonl = JSON.stringify({
    kind: "user",
    text: "Synthetic history",
    date: "2026-10-23T12:00:00Z",
  })
  await page.getByLabel("Messages file", { exact: true }).setInputFiles({
    name: "history.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(jsonl),
  })
  await page.getByLabel("Messages file", { exact: true }).evaluate((input) => {
    const form = input.closest("form")!
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
  })
  await expect(
    page.getByText("Import response unavailable.", { exact: true })
  ).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toEqual({ jsonl })
  await page
    .getByRole("button", { name: "Retry same import", exact: true })
    .click()
  await expect(
    page.getByText(
      "1 messages imported. Their summaries will build in the background.",
      { exact: true }
    )
  ).toBeVisible()
  expect(bodies).toEqual([{ jsonl }, { jsonl }])
})

test("WhatsApp requires confirmation before retry and retains that exact authorization after an uncertain response", async ({
  page,
}) => {
  const id = "12345678-1234-4234-a234-123456789abc"
  const bodies: unknown[] = []
  const view = {
    configured: true,
    enabled: true,
    revision: 1,
    agentId: "home",
    agentName: "Navi",
    contactUrl: null,
    messages: [
      {
        id,
        agentId: "home",
        state: "uncertain",
        error: "Delivery unconfirmed.",
        createdAt: 1,
      },
    ],
  }
  await page.route("**/api/agent/whatsapp**", async (route) => {
    if (route.request().method() !== "POST")
      return route.fulfill({ json: view })
    bodies.push(route.request().postDataJSON())
    return route.fulfill({
      status: 503,
      json: { error: "Retry acknowledgement unavailable." },
    })
  })
  await signIn(page, "/settings/channels")
  await page.getByRole("button", { name: "Retry reply", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Send this WhatsApp reply again?" })
  ).toBeVisible()
  expect(bodies).toEqual([])
  await page.getByRole("button", { name: "Cancel", exact: true }).click()
  expect(bodies).toEqual([])
  await page.getByRole("button", { name: "Retry reply", exact: true }).click()
  await page.getByRole("button", { name: "Send again", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Retry same request", exact: true })
  ).toBeVisible()
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toMatchObject({ id, acknowledgeDuplicateRisk: true })
  await page.reload()
  await expect(
    page.getByRole("button", { name: "Retry same request", exact: true })
  ).toBeVisible()
  expect(bodies).toHaveLength(1)
  await page
    .getByRole("button", { name: "Retry same request", exact: true })
    .click()
  await expect.poll(() => bodies.length).toBe(2)
  expect(bodies[1]).toEqual(bodies[0])
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
})

test("leaving Memory during a held native file read prevents its later submission", async ({
  page,
}) => {
  const bodies: unknown[] = []
  await page.route("**/api/agent/import?**", async (route) => {
    bodies.push(route.request().postDataJSON())
    return route.fulfill({ json: { added: 1 } })
  })
  await signIn(page, "/agents/home/memory")
  await page.getByRole("tab", { name: "Archive", exact: true }).click()
  await page.evaluate(() => {
    File.prototype.text = () =>
      new Promise<string>((resolve) =>
        Reflect.set(window, "releaseMemoryFileRead", resolve)
      )
  })
  await page.getByLabel("Messages file", { exact: true }).setInputFiles({
    name: "held.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from("synthetic"),
  })
  await page
    .getByRole("button", { name: "Import history", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => typeof Reflect.get(window, "releaseMemoryFileRead"))
    )
    .toBe("function")
  await page.getByRole("tab", { name: "Notes", exact: true }).click()
  await page.getByRole("tab", { name: "Archive", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Import history", exact: true })
  ).toBeDisabled()
  await page.evaluate(async () => {
    Reflect.get(window, "releaseMemoryFileRead")("released old file")
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  expect(bodies).toEqual([])
  await expect(page.getByText(/messages imported/)).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Readable HTML", exact: true })
  ).toHaveAttribute("download", "")
  await expect(
    page.getByRole("link", { name: "Archive JSONL", exact: true })
  ).toHaveAttribute("download", "")
})
