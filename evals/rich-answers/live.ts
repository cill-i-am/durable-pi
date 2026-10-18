import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parseArgs } from "node:util"

import { chromium, expect, type Page } from "@playwright/test"

import { cases } from "./cases"
import { grade } from "./grade"

const { values } = parseArgs({
  options: {
    headed: { type: "boolean" },
    login: { type: "boolean" },
    base: { type: "string", default: "https://bot.cill-i-am.com" },
    case: { type: "string" },
    repeats: { type: "string", default: "1" },
    output: { type: "string", default: "evals/rich-answers/results" },
  },
})
if (values.login && !values.headed)
  throw new Error("Use --headed with --login to complete normal sign-in")
const base = new URL(values.base!)
if (
  base.protocol !== "https:" &&
  !["localhost", "127.0.0.1"].includes(base.hostname)
)
  throw new Error("Live evals require HTTPS")
const repeats = Number(values.repeats)
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10)
  throw new Error("Choose 1–10 repeats")
const selected = cases.filter((test) => !values.case || test.id === values.case)
if (!selected.length) throw new Error("Unknown eval case")
const root = resolve(values.output!)
const runId = new Date().toISOString().replaceAll(":", "-")
const directory = resolve(root, runId)
const graderHash = createHash("sha256")
  .update(await readFile(new URL("./grade.ts", import.meta.url)))
  .update(await readFile(new URL("./card-checks.ts", import.meta.url)))
  .digest("hex")
await mkdir(directory, { recursive: true, mode: 0o700 })
// A dedicated browser profile keeps login in the browser, never in reports.
const context = await chromium.launchPersistentContext(
  resolve(root, "browser-profile"),
  {
    headless: !values.headed,
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 },
  }
)
const results: unknown[] = []
async function archiveAgent(page: Page, name: string) {
  await page
    .getByRole("button", { name: `Options for ${name}`, exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Archive", exact: true }).click()
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Archive agent", exact: true })
    .click()
  await expect(page.getByRole("alertdialog")).toHaveCount(0)
}
try {
  const page = await context.newPage()
  await page.goto(new URL("/agents", base).href)
  if (values.login) {
    console.log(
      "Complete sign-in in the eval browser. No model requests are sent during login setup."
    )
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .waitFor({ timeout: 300_000 })
    console.log("Eval browser login is ready.")
  } else {
    try {
      await page
        .getByRole("button", { name: "New agent", exact: true })
        .waitFor({ timeout: 30_000 })
    } catch {
      throw new Error(
        "Sign in first: pnpm eval:rich-answers:live --headed --login"
      )
    }
    for (const test of selected)
      for (let trial = 1; trial <= repeats; trial++) {
        const name = `Eval ${test.id} ${runId.slice(11, 19)} ${trial}`
        let agentUrl: string | undefined
        let finished = false
        try {
          // Archiving opens the archive collection. Begin each new trial from
          // the active collection, including after a retained/error case.
          await page.goto(new URL("/agents", base).href)
          await page
            .getByRole("button", { name: "New agent", exact: true })
            .click()
          await page
            .getByRole("textbox", { name: "Name", exact: true })
            .fill(name)
          await page
            .getByRole("textbox", { name: "Purpose", exact: true })
            .fill("Your personal thinking partner")
          await page
            .getByRole("button", { name: "Create agent", exact: true })
            .click()
          const composer = page.getByRole("textbox", {
            name: `Message ${name}`,
            exact: true,
          })
          await composer.waitFor({ timeout: 60_000 })
          agentUrl = page.url()
          await composer.fill(test.prompt)
          await expect(
            page.getByRole("button", { name: "Send message", exact: true })
          ).toBeEnabled({ timeout: 60_000 })
          await page
            .getByRole("button", { name: "Send message", exact: true })
            .click()
          const staleClientReloads = await waitForAnswer(page)
          const ui = await page.evaluate(() => ({
            failed: document.body.innerText.includes("Retry message"),
            fallback: document.body.innerText.includes(
              "Couldn’t display this result"
            ),
            layout:
              document
                .querySelector("[data-weather-layout]")
                ?.getAttribute("data-weather-layout") ?? undefined,
            model:
              document
                .querySelector('[aria-label="Model profile"]')
                ?.getAttribute("title") ?? undefined,
            failedTools: [
              ...document.querySelectorAll('[data-slot="trace-description"]'),
            ].filter((item) => item.textContent?.trim() === "Failed").length,
            entryScript:
              document
                .querySelector('script[type="module"][src]')
                ?.getAttribute("src") ?? undefined,
          }))
          const stem = resolve(directory, `${test.id}-${trial}`)
          await page.screenshot({ path: `${stem}.png`, fullPage: true })
          await page
            .getByRole("button", { name: "Memory", exact: true })
            .click()
          await page
            .getByRole("tab", { name: "Export & import", exact: true })
            .click()
          const pending = page.waitForEvent("download")
          await page
            .getByRole("link", { name: "Archive JSONL", exact: true })
            .click()
          const download = await pending
          await download.saveAs(`${stem}.jsonl`)
          const evidence = { ...ui, staleClientReloads }
          await writeFile(
            `${stem}.ui.json`,
            JSON.stringify(evidence, null, 2),
            { mode: 0o600 }
          )
          const result = grade(
            test,
            await readFile(`${stem}.jsonl`, "utf8"),
            evidence
          )
          results.push({
            ...result,
            trial,
            agentUrl,
            status: result.pass ? "passed" : "failed",
          })
          finished = true
          console.log(`${result.pass ? "PASS" : "FAIL"} ${test.id} #${trial}`)
        } catch (error) {
          await page
            .screenshot({
              path: resolve(directory, `${test.id}-${trial}-error.png`),
              fullPage: true,
            })
            .catch(() => undefined)
          results.push({
            id: test.id,
            trial,
            agentUrl,
            status: "error",
            error: error instanceof Error ? error.message : String(error),
          })
          console.error(`ERROR ${test.id} #${trial}`)
        } finally {
          // Archive only completed, positively identified eval agents. Recovery
          // remains available in the product; interrupted runs stay for inspection.
          await writeFile(
            resolve(directory, "results.json"),
            JSON.stringify(
              {
                version: 1,
                mode: "live-site",
                base: base.origin,
                runId,
                casesHash: createHash("sha256")
                  .update(JSON.stringify(selected))
                  .digest("hex"),
                graderHash,
                repeats,
                requested: selected.length * repeats,
                results,
              },
              null,
              2
            ),
            { mode: 0o600 }
          )
          if (finished) {
            try {
              await archiveAgent(page, name)
            } catch {
              console.error(
                `Cleanup incomplete for ${name}; retained at ${agentUrl}`
              )
              process.exitCode = 1
            }
          }
        }
      }
    const failed = results.filter(
      (result) =>
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        result.status !== "passed"
    ).length
    console.log(
      `${results.length - failed}/${selected.length * repeats} passed. Report: ${directory}/results.json`
    )
    if (failed || results.length !== selected.length * repeats)
      process.exitCode = 1
  }
} finally {
  await context.close()
}

// A deploy can replace lazy module assets while a tab is open. Reload saved
// history at most twice; never replay the submitted request.
async function waitForAnswer(page: Page): Promise<number> {
  for (let reloads = 0; reloads <= 2; reloads++) {
    await page.waitForFunction(
      () => {
        if (document.body.innerText.includes("Couldn’t open this workspace."))
          return true
        const answer = document.querySelector(".assistant-message")
        const status = document
          .querySelector('[data-slot="badge"][data-agent-status]')
          ?.getAttribute("data-agent-status")
        return (
          !!answer?.textContent?.trim() &&
          ["ready", "failed", "blocked", "needs-approval"].includes(
            status ?? ""
          ) &&
          !document.querySelector('[aria-label="Stop response"]')
        )
      },
      undefined,
      { timeout: 240_000 }
    )
    if (
      !(await page
        .getByRole("heading", {
          name: "Couldn’t open this workspace.",
          exact: true,
        })
        .isVisible())
    )
      return reloads
    if (reloads < 2) await page.reload()
  }
  throw new Error(
    "Workspace failed to load after two reloads; submitted request retained"
  )
}
