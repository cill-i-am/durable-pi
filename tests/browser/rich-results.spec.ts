import { readFile } from "node:fs/promises"

import { expect, test, type Page } from "@playwright/test"

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
    .getByRole("region", { name: "Your agents" })
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
  await workspace.getByRole("button", { name: "Close", exact: true }).click()
  await expect(
    gallery.getByRole("button", { name: "Compare (2)", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await gallery.getByRole("button", { name: "Close", exact: true }).click()
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await composer.fill("Keep my original requirements.")
  await page
    .getByRole("button", { name: "Explore answers", exact: true })
    .click()
  await gallery.getByRole("tab", { name: "Questions", exact: true }).click()
  await gallery.getByRole("button", { name: /^Comfort/ }).click()
  await gallery
    .getByLabel("Add your own answer", { exact: true })
    .fill("Light enough for travelling")
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
