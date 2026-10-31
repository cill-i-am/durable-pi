import { expect, test } from "@playwright/test"

test("model selection has four choices and new messages ignore a retired job preset", async ({
  page,
}) => {
  await page.goto("/agents")
  await page
    .getByLabel("Email", { exact: true })
    .fill("browser-smoke@example.invalid")
  await page
    .getByLabel("Password", { exact: true })
    .fill("Disposable browser fixture password 2026!")
  await page.getByRole("button", { name: "Sign in", exact: true }).click()
  await expect(page.getByRole("region", { name: "Assistants" })).toBeVisible()
  await page.evaluate(() =>
    sessionStorage.setItem(
      "pi:composer:benchmark-owner:home",
      JSON.stringify({
        version: 1,
        text: "Keep my existing draft",
        files: [],
        profile: "auto",
        job: "planning",
        attempt: null,
      })
    )
  )
  await page.goto("/agents/navi")
  const composer = page.getByRole("textbox", {
    name: "Message Navi",
    exact: true,
  })
  await expect(composer).toHaveValue("Keep my existing draft")
  await page.getByRole("button", { name: "Model", exact: true }).click()
  const menu = page.getByRole("menu")
  await expect(menu.getByRole("menuitemradio")).toHaveCount(4)
  await expect(menu.getByText("Model", { exact: true })).toBeVisible()
  await expect(menu).not.toContainText(
    /Advanced|explicit job|Everyday conversation|Think harder|job defaults|ChatGPT plan usage/
  )
  await page.evaluate(() =>
    Promise.allSettled(
      document
        .getAnimations()
        .filter(
          (animation) =>
            animation.effect?.getComputedTiming().iterations !== Infinity
        )
        .map((animation) => animation.finished)
    )
  )
  await page.screenshot({
    path: `test-results/model-selection-${test.info().project.name}.png`,
  })
  await page.keyboard.press("Escape")
  const sent = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/agent/send"
  )
  await page.getByRole("button", { name: "Send message", exact: true }).click()
  expect((await sent).postDataJSON()).toMatchObject({
    text: "Keep my existing draft",
    job: "conversation",
  })
  await expect(
    page.getByText("Fixture reply received.", { exact: true })
  ).toBeVisible()
})
