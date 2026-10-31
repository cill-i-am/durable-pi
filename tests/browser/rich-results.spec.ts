import { readFile } from "node:fs/promises"

import { expect, test, type Page } from "@playwright/test"

import { chatMessages } from "../../src/conversations/adapters/tanstack"

async function openConversation(page: Page) {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await page
    .getByRole("region", { name: "Assistants" })
    .getByRole("link", { name: /Navi/ })
    .click()
  await expect(
    page.getByRole("textbox", { name: "Message Navi", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Explore answers", exact: true })
    .click()
  return page.getByRole("dialog", {
    name: "Answers you can explore",
    exact: true,
  })
}

test("a shopping shortlist survives workspace expansion and questions append to an unsent draft", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let submitted = false
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/agent/send"
    )
      submitted = true
  })
  const gallery = await openConversation(page)
  await expect(
    gallery.getByText("Illustrative data. Add a sample prompt to your draft.")
  ).toBeVisible()
  await gallery
    .getByRole("button", { name: "Shortlist Everyday wireless", exact: true })
    .click()
  await gallery
    .getByRole("button", { name: "Shortlist Studio wireless", exact: true })
    .click()
  await gallery
    .getByRole("button", { name: "Compare (2)", exact: true })
    .click()
  await gallery
    .getByRole("button", { name: "Open workspace", exact: true })
    .click()
  const workspace = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("table") })
  await expect(
    workspace.getByRole("columnheader", {
      name: "Everyday wireless",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    workspace.getByRole("columnheader", {
      name: "Studio wireless",
      exact: true,
    })
  ).toBeVisible()
  await workspace
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  await expect(
    gallery.getByRole("button", { name: "Open workspace", exact: true })
  ).toBeFocused()
  await expect(
    gallery.getByRole("button", { name: "Compare (2)", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await gallery
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Explore answers", exact: true })
  ).toBeFocused()
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await composer.fill("Keep my original requirements.")
  await page
    .getByRole("button", { name: "Explore answers", exact: true })
    .click()
  await gallery.getByRole("tab", { name: "Questions", exact: true }).click()
  await expect(
    gallery.getByRole("button", { name: "Add answer to draft", exact: true })
  ).toBeDisabled()
  const comfort = gallery.getByRole("button", { name: /^Comfort/ })
  const battery = gallery.getByRole("button", { name: /^Battery life/ })
  await comfort.focus()
  await page.keyboard.press("ArrowDown")
  await expect(battery).toBeFocused()
  await gallery.getByRole("button", { name: /^Comfort/ }).click()
  await expect(comfort).toHaveAttribute("aria-pressed", "true")
  await expect(battery).toHaveAttribute("aria-pressed", "false")
  await gallery
    .getByLabel("Add your own answer", { exact: true })
    .fill("Light enough for travelling")
  await gallery
    .getByRole("button", { name: "Add answer to draft", exact: true })
    .scrollIntoViewIfNeeded()
  await expect(
    gallery.getByRole("heading", {
      name: "Answers you can explore",
      exact: true,
    })
  ).toBeInViewport()
  await expect(
    gallery.getByRole("button", { name: "Close dialog", exact: true })
  ).toBeInViewport()
  await gallery
    .getByRole("button", { name: "Add answer to draft", exact: true })
    .click()
  await expect(gallery).not.toBeVisible()
  await expect(composer).toHaveValue(
    "Keep my original requirements.\n\nFor “What matters most for your headphones?”: Comfort; Light enough for travelling"
  )
  await expect(composer).toBeFocused()
  expect(submitted).toBe(false)
  expect(errors).toEqual([])
})

test("table search and sorting survive expansion and govern the exported CSV", async ({
  page,
}) => {
  const gallery = await openConversation(page)
  await gallery.getByRole("tab", { name: "Data tables", exact: true }).click()
  await gallery.getByRole("textbox", { name: /^Filter / }).fill("Food")
  await expect(gallery.getByText(/4 of 10 rows/)).toBeVisible()
  await gallery
    .getByRole("button", { name: "Sort by Amount (EUR)", exact: true })
    .click()
  await gallery
    .getByRole("button", { name: "Open workspace", exact: true })
    .click()
  const workspace = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("table") })
  await expect(
    workspace.getByRole("textbox", { name: /^Filter / })
  ).toHaveValue("Food")
  await expect(
    workspace.getByRole("columnheader", {
      name: "Sort by Amount (EUR)",
      exact: true,
    })
  ).toHaveAttribute("aria-sort", "descending")
  const downloadPromise = page.waitForEvent("download")
  await workspace
    .getByRole("button", { name: "Export CSV", exact: true })
    .click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe("pi-table.csv")
  const csv = await readFile((await download.path())!, "utf8")
  expect(csv.replace(/^\uFEFF/, "")).toBe(
    [
      '"Item","Category","Amount (EUR)","Paid"',
      '"Groceries","Food","86.4","true"',
      '"Lunch","Food","16.5","true"',
      '"Vegetables","Food","12.2","true"',
      '"Coffee","Food","7.8","true"',
    ].join("\r\n")
  )
})

test("weather adapts from a dated weekend comparison to a detailed day and a compact week", async ({
  page,
}) => {
  const gallery = await openConversation(page)
  await gallery.getByRole("tab", { name: "Weather", exact: true }).click()
  await expect(
    gallery.getByRole("region", {
      name: "Saturday 24 October 2026",
      exact: true,
    })
  ).toBeVisible()
  await expect(
    gallery.getByRole("region", { name: "Sunday 25 October 2026", exact: true })
  ).toBeVisible()
  await expect(gallery.getByText("Maximum wind", { exact: true })).toHaveCount(
    2
  )
  await expect(
    gallery.getByLabel("Current conditions", { exact: true })
  ).toHaveCount(0)
  await gallery.getByRole("button", { name: "1 day", exact: true }).click()
  await expect(
    gallery.getByRole("region", {
      name: "Saturday 24 October 2026",
      exact: true,
    })
  ).toHaveCount(0)
  const hourly = gallery.getByRole("region", {
    name: "Hourly forecast for Sunday 25 October 2026",
    exact: true,
  })
  await expect(hourly).toBeVisible()
  await hourly.focus()
  await expect(hourly).toBeFocused()
  await expect(
    gallery.getByText("Feels like up to 15°", { exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await gallery.getByRole("button", { name: "7 days", exact: true }).click()
  await expect(
    gallery.getByRole("region", { name: /^Hourly forecast for/ })
  ).toHaveCount(0)
  await expect(
    gallery.getByRole("region", {
      name: /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d+ October 2026$/,
    })
  ).toHaveCount(7)
  await expect(
    gallery.getByText("7-day forecast", { exact: false })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
})

const blankMapStyle = {
  version: 8,
  sources: {},
  layers: [
    {
      id: "background",
      type: "background",
      paint: { "background-color": "#eeeeee" },
    },
  ],
}

test("map leases survive selection, theme replacement and route teardown without stale canvases", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.emulateMedia({ colorScheme: "light" })
  let styles = 0
  await page.route("https://basemaps.cartocdn.com/**/style.json", (route) => {
    styles++
    return route.fulfill({ json: blankMapStyle })
  })
  const gallery = await openConversation(page)
  await gallery.getByRole("tab", { name: "Maps", exact: true }).click()
  const map = gallery.getByRole("region", {
    name: "Interactive place map",
    exact: true,
  })
  const second = map.getByRole("button", {
    name: "Show St Stephen’s Green on map",
    exact: true,
  })
  await expect(map.getByLabel("Loading map", { exact: true })).toHaveCount(0)
  await second.click()
  await expect(second).toHaveAttribute("aria-pressed", "true")
  const beforeTheme = styles
  await page.emulateMedia({ colorScheme: "dark" })
  await expect.poll(() => styles).toBeGreaterThan(beforeTheme)
  await expect(map.getByLabel("Loading map", { exact: true })).toHaveCount(0)
  await expect(second).toHaveAttribute("aria-pressed", "true")
  await expect(map.locator("canvas")).toHaveCount(1)
  await gallery.getByRole("tab", { name: "Routes", exact: true }).click()
  const routeMap = gallery.getByRole("region", {
    name: "Interactive place map",
    exact: true,
  })
  await expect(routeMap.getByLabel("Loading map", { exact: true })).toHaveCount(
    0
  )
  await expect(routeMap.locator("canvas")).toHaveCount(1)
  await routeMap
    .getByRole("button", {
      name: "Show National Gallery of Ireland on map",
      exact: true,
    })
    .click()
  await gallery.getByRole("tab", { name: "Weather", exact: true }).click()
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0)
  await gallery
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  expect(errors).toEqual([])
})

test("closing a map during a held style request releases it and leaves the next map usable", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let requests = 0
  await page.route(
    "https://basemaps.cartocdn.com/**/style.json",
    async (route) => {
      requests++
      if (requests === 1) await held
      await route.fulfill({ json: blankMapStyle }).catch(() => {})
    }
  )
  const gallery = await openConversation(page)
  await gallery.getByRole("tab", { name: "Maps", exact: true }).click()
  await expect.poll(() => requests).toBe(1)
  await gallery.getByRole("tab", { name: "Questions", exact: true }).click()
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0)
  release()
  await gallery.getByRole("tab", { name: "Routes", exact: true }).click()
  const map = gallery.getByRole("region", {
    name: "Interactive place map",
    exact: true,
  })
  await expect(map.getByLabel("Loading map", { exact: true })).toHaveCount(0)
  await expect(map.locator("canvas")).toHaveCount(1)
  await expect(
    map.getByRole("button", {
      name: "Show St Stephen’s Green on map",
      exact: true,
    })
  ).toBeEnabled()
  await gallery
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0)
  expect(errors).toEqual([])
})

test("loaded syntax highlighting preserves code text and unsupported-language fallback", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route("**/api/agent/events?**", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: [
        {
          type: "MESSAGES_SNAPSHOT",
          messages: chatMessages([
            {
              id: "highlight-fixture",
              status: "done",
              text: "Show code",
              error: null,
              created_at: "2026-10-23T14:00:00Z",
              answer:
                "```typescript\nconst answer = 42\nconsole.log(answer)\n```\n\n```custom-unknown\nplain & <safe>\n```",
            },
          ]),
        },
        {
          type: "CUSTOM",
          name: "durable-pi.metadata",
          value: {
            model: "test",
            connected: true,
            memory: { messages: 2, summaries: 0, ready: true, notes: [] },
          },
        },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    })
  )
  const gallery = await openConversation(page)
  await gallery
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  const code = page.locator(
    ".assistant-message code[data-slot=code-block-code]"
  )
  await expect(code).toHaveCount(2)
  await expect(code.first()).toContainText("const answer = 42")
  await expect(code.first()).toContainText("console.log(answer)")
  await expect(
    code.first().locator('span[style*="--shiki-light"]').first()
  ).toBeVisible()
  await expect(code.nth(1)).toHaveText("plain & <safe>")
  await expect(code.nth(1).locator('span[style*="--shiki-light"]')).toHaveCount(
    0
  )
  expect(errors).toEqual([])
})

test("failed map loading keeps accessible addresses and a selected-place fallback", async ({
  page,
}) => {
  await page.route("https://basemaps.cartocdn.com/**/style.json", (route) =>
    route.abort()
  )
  const gallery = await openConversation(page)
  await page.clock.install()
  await gallery.getByRole("tab", { name: "Maps", exact: true }).click()
  const map = gallery.getByRole("region", {
    name: "Interactive place map",
    exact: true,
  })
  await expect(map.locator("canvas")).toHaveCount(1)
  await page.clock.fastForward(16000)
  await expect(
    map.getByText("The interactive map is unavailable.", { exact: true })
  ).toBeVisible()
  await gallery
    .getByRole("group", { name: "Places", exact: true })
    .getByRole("button", {
      name: "St Stephen’s Green Dublin 2, Ireland",
      exact: true,
    })
    .click()
  await expect(
    map.getByRole("link", {
      name: "Open St Stephen’s Green in OpenStreetMap",
      exact: true,
    })
  ).toHaveAttribute("href", /mlat=53\.3382&mlon=-6\.2591/)
  await expect(
    gallery.getByRole("link", { name: "Get directions", exact: true })
  ).toBeVisible()
  await gallery
    .getByRole("button", { name: "Close dialog", exact: true })
    .click()
  await expect(page.locator(".maplibregl-canvas")).toHaveCount(0)
})
