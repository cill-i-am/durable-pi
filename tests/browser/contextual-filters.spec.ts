import { expect, test, type Page } from "@playwright/test"

async function openTable(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.goto("/agents/navi/examples")
  const examples = page.getByRole("region", {
    name: "Answer examples",
    exact: true,
  })
  await examples.getByRole("tab", { name: "Data tables", exact: true }).click()
  await expect(examples.getByRole("table")).toBeVisible()
  return examples
}

test("a local filter validates visibly and retains one draft through dismissal and responsive drawers", async ({
  page,
  isMobile,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const examples = await openTable(page)
  const trigger = examples.getByRole("button", {
    name: "Add filter",
    exact: true,
  })
  await trigger.click()
  const editor = page.getByRole("dialog", { name: "Add filter", exact: true })
  await expect(editor).toBeVisible()
  const value = editor.getByLabel("Value", { exact: true })
  const apply = editor.getByRole("button", {
    name: "Apply filter",
    exact: true,
  })
  await expect(apply).toBeEnabled()
  await apply.click()
  await expect(editor.getByRole("alert")).toHaveText("Enter a value.")
  await expect(value).toHaveAttribute("aria-invalid", "true")
  await expect(value).toBeFocused()

  await editor.getByRole("combobox", { name: "Column", exact: true }).click()
  await page.getByRole("option", { name: "Amount (EUR)", exact: true }).click()
  await expect(editor).toBeVisible()
  await expect(editor.getByText("EUR", { exact: true })).toBeVisible()
  await expect(editor.getByText(/fraction/)).toHaveCount(0)
  await editor.getByRole("combobox", { name: "Condition", exact: true }).click()
  await page.getByRole("option", { name: "Less than", exact: true }).click()
  await value.fill("-10.5")
  if (isMobile)
    await editor.getByRole("button", { name: "Close", exact: true }).click()
  else await page.keyboard.press("Escape")
  await expect(editor).not.toBeVisible()
  await expect(trigger).toBeFocused()
  await trigger.click()
  await expect(value).toHaveValue("-10.5")

  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 900 },
    { width: 390, height: 430 },
  ]) {
    await page.setViewportSize(viewport)
    await expect(editor).toBeVisible()
    await expect(value).toHaveValue("-10.5")
    await expect(
      editor.getByRole("combobox", { name: "Column", exact: true })
    ).toContainText("Amount (EUR)")
    await expect(
      editor.getByRole("combobox", { name: "Condition", exact: true })
    ).toContainText("Less than")
    const valueId = await value.getAttribute("id")
    expect(
      await page.evaluate(
        (id) => document.querySelectorAll(`[id="${CSS.escape(id!)}"]`).length,
        valueId
      )
    ).toBe(1)
    if (viewport.width < 768) {
      await expect(editor).toHaveAttribute("data-overlay-mobile", "true")
      await expect(value).toHaveCSS("font-size", "16px")
      expect((await apply.boundingBox())!.height).toBeGreaterThanOrEqual(44)
    } else {
      await expect(editor).not.toHaveAttribute("aria-modal", "true")
      expect((await editor.boundingBox())!.width).toBe(320)
    }
  }
  await value.fill("25")
  await apply.click()
  await expect(editor).not.toBeVisible()
  await expect(
    examples.getByRole("button", {
      name: "Remove Amount (EUR) filter",
      exact: true,
    })
  ).toBeVisible()
  await expect(examples.getByText(/6 of 10 rows/)).toBeVisible()
  await examples
    .getByRole("button", { name: "Remove Amount (EUR) filter", exact: true })
    .click()
  await expect(examples.getByText(/10 of 10 rows/)).toBeVisible()
  expect(errors).toEqual([])
})
