// Actual mounted SkillsPanel; local synthetic HTTP only, no backend/provider effects.
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const require = createRequire(new URL("../../package.json", import.meta.url))
const { build } = createRequire(require.resolve("alchemy"))("esbuild")
const { chromium } = require("@playwright/test")
const bundle = await build({
  stdin: {
    contents: `import React,{useState}from'react';import{createRoot}from'react-dom/client';import{SkillsPanel}from'./src/features/skills/skills-panel';function App(){const[agent,setAgent]=useState(),[open,setOpen]=useState(true);window.skillHost={agent,assign:()=>setAgent('old'),change:()=>setAgent('new'),close:()=>setOpen(false),open:()=>setOpen(true)};return <><div data-agent={agent}/><SkillsPanel embedded agentId={agent} agentName={agent} open={open} onOpenChange={setOpen}/></>}createRoot(document.getElementById('root')).render(<App/>);`,
    loader: "tsx",
    resolveDir: root,
  },
  bundle: true,
  platform: "browser",
  write: false,
  format: "iife",
  tsconfig: `${root}/tsconfig.json`,
  define: { "process.env.NODE_ENV": '"development"' },
})
const server = createServer((req, res) => {
  res.setHeader(
    "content-type",
    req.url === "/app.js" ? "text/javascript" : "text/html"
  )
  res.end(
    req.url === "/app.js"
      ? bundle.outputFiles[0].text
      : '<div id="root"></div><script src="/app.js"></script>'
  )
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const browser = await chromium.launch({ headless: true })
const results = []
async function fixture(page) {
  await page.addInitScript(() => {
    const id = "00000000-0000-0000-0000-000000000001"
    const old = {
      id,
      name: "Original",
      body: "Original instructions",
      revision: 1,
      stateRevision: 1,
      createdAt: "2026-10-23T00:00:00.000Z",
      archived: false,
    }
    const newSkill = {
      ...old,
      id: "00000000-0000-0000-0000-000000000002",
      name: "New agent skill",
    }
    const tool = {
      name: `mcp_${"a".repeat(40)}`,
      connectionId: `mcp-${"a".repeat(32)}`,
      connectionRevision: 1,
      connectionName: "Executor",
      remoteName: "skills",
      description: "",
      parameters: {},
    }
    const hosted = {
      name: "hosted-instructions",
      description: "Pinned instructions",
      app: { id: "app", slug: "personal-skills", name: "App" },
      deployment: "main",
      revision: "pinned",
    }
    window.skillFixture = {
      old,
      newSkill,
      tool,
      hosted,
      library: [old],
      pending: [],
      calls: [],
      hold: "",
      failSave: false,
      conflictSave: false,
      aborted: 0,
    }
    window.fetch = async (raw, init) => {
      const url = new URL(String(raw), location.href),
        body = init?.body ? JSON.parse(init.body) : undefined,
        fixture = window.skillFixture
      fixture.calls.push({
        path: url.pathname,
        agent: url.searchParams.get("agent"),
        body,
      })
      if (fixture.hold && url.pathname.endsWith(fixture.hold) && body)
        return new Promise((resolve) => {
          init?.signal?.addEventListener("abort", () => {
            fixture.aborted++
          })
          fixture.pending.push((value) => resolve(Response.json(value)))
        })
      if (url.pathname.endsWith("/skills/save")) {
        if (fixture.failSave) {
          fixture.failSave = false
          throw new Error("response lost")
        }
        if (fixture.conflictSave) {
          fixture.conflictSave = false
          fixture.library = [
            {
              ...fixture.old,
              revision: 2,
              stateRevision: 2,
              body: "Other saved instructions",
            },
          ]
          return Response.json(
            { error: "A newer revision is saved." },
            { status: 409 }
          )
        }
        const saved = {
          ...fixture.old,
          ...body,
          revision: body.expectedRevision + 1,
          stateRevision: body.expectedRevision + 1,
        }
        fixture.library = [saved]
        return Response.json(saved)
      }
      if (url.pathname.endsWith("/skills/archive")) {
        const saved = {
          ...fixture.library[0],
          archived: body.archived,
          stateRevision: body.expectedStateRevision + 1,
        }
        fixture.library = [saved]
        return Response.json(saved)
      }
      if (url.pathname.endsWith("/skill-selection"))
        return Response.json({
          revision: url.searchParams.get("agent") === "new" ? 7 : 1,
          skills: url.searchParams.get("agent") === "new" ? [newSkill] : [old],
        })
      if (url.pathname.endsWith("/skills"))
        return Response.json({ skills: fixture.library })
      if (url.pathname.endsWith("/connections"))
        return Response.json({
          connections: [
            {
              id: tool.connectionId,
              name: "Executor",
              url: "https://example.invalid",
              revision: 1,
              active: true,
              status: "ready",
              authorizeUrl: null,
              tools: [tool],
            },
          ],
        })
      if (url.pathname.endsWith("/skills/import/list"))
        return Response.json({ skills: [hosted] })
      if (url.pathname.endsWith("/skills/import/read"))
        return Response.json({
          name: hosted.name,
          body: "Hosted body",
          source: {
            ...hosted,
            connectionId: tool.connectionId,
            connectionName: tool.connectionName,
            toolName: tool.name,
            files: ["SKILL.md"],
          },
        })
      if (url.pathname.endsWith(`/skills/${id}`))
        return Response.json({ versions: [old] })
      throw new Error(`Unexpected fixture request ${url.pathname}`)
    }
  })
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole("button", { name: "Edit", exact: true }).waitFor()
}
const cases = {
  async "held selection is fenced after changing agents"(page) {
    await page.evaluate(() => window.skillHost.assign())
    await page
      .getByRole("button", { name: "Remove Original from this assistant" })
      .waitFor()
    await page.evaluate(() => {
      window.skillFixture.hold = "/skill-selection"
    })
    await page
      .getByRole("button", { name: "Remove Original from this assistant" })
      .click()
    await page.waitForFunction(() => window.skillFixture.pending.length === 1)
    await page.evaluate(() => window.skillHost.change())
    await page
      .getByRole("button", {
        name: "Remove New agent skill from this assistant",
      })
      .waitFor()
    await page.waitForFunction(() => window.skillFixture.aborted === 1)
    await page.evaluate(() =>
      window.skillFixture.pending[0]({ revision: 2, skills: [] })
    )
    await page.waitForTimeout(30)
    assert.equal(
      await page
        .getByRole("button", {
          name: "Remove New agent skill from this assistant",
        })
        .count(),
      1
    )
  },
  async "lost save retries the same identity and exact CAS input"(page) {
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    await page
      .getByLabel("Instructions", { exact: true })
      .fill("My exact instructions")
    await page.evaluate(() => {
      window.skillFixture.failSave = true
    })
    await page.getByRole("button", { name: "Save skill", exact: true }).click()
    await page
      .getByRole("button", { name: "Retry same change", exact: true })
      .waitFor()
    assert.equal(
      await page.getByLabel("Instructions", { exact: true }).inputValue(),
      "My exact instructions"
    )
    await page
      .getByRole("button", { name: "Retry same change", exact: true })
      .click()
    await page.waitForFunction(
      () =>
        window.skillFixture.calls.filter((call) =>
          call.path.endsWith("/skills/save")
        ).length === 2
    )
    const calls = await page.evaluate(() =>
      window.skillFixture.calls.filter((call) =>
        call.path.endsWith("/skills/save")
      )
    )
    assert.deepEqual(calls[0].body, calls[1].body)
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor()
  },
  async "conflict reload preserves the draft until explicit reapply"(page) {
    await page.getByRole("button", { name: "Edit", exact: true }).click()
    await page
      .getByLabel("Instructions", { exact: true })
      .fill("My conflict draft")
    await page.evaluate(() => {
      window.skillFixture.conflictSave = true
    })
    await page.getByRole("button", { name: "Save skill", exact: true }).click()
    await page.getByRole("button", { name: "Reload", exact: true }).click()
    await page
      .getByRole("button", { name: "Keep my draft", exact: true })
      .waitFor()
    assert.equal(
      await page.getByLabel("Instructions", { exact: true }).inputValue(),
      "My conflict draft"
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.skillFixture.calls.filter((call) =>
            call.path.endsWith("/skills/save")
          ).length
      ),
      1
    )
    await page
      .getByRole("button", { name: "Keep my draft", exact: true })
      .click()
    await page.getByRole("button", { name: "Save skill", exact: true }).click()
    await page.getByRole("button", { name: "Edit", exact: true }).waitFor()
    const calls = await page.evaluate(() =>
      window.skillFixture.calls.filter((call) =>
        call.path.endsWith("/skills/save")
      )
    )
    assert.equal(calls[1].body.expectedRevision, 2)
    assert.equal(calls[1].body.id, calls[0].body.id)
    assert.equal(calls[1].body.body, "My conflict draft")
  },
  async "file import stays local and closing hosted read discards its late preview"(
    page
  ) {
    await page.getByLabel("Import skill Markdown").setInputFiles({
      name: "Imported.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# Local import\n\nPreserved text"),
    })
    await page.getByLabel("Instructions", { exact: true }).waitFor()
    assert.equal(
      await page.getByLabel("Instructions", { exact: true }).inputValue(),
      "# Local import\n\nPreserved text"
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.skillFixture.calls.filter((call) =>
            call.path.endsWith("/skills/save")
          ).length
      ),
      0
    )
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.getByRole("button", { name: "Import", exact: true }).click()
    await page
      .getByRole("menuitem", { name: "From Executor", exact: true })
      .click()
    await page
      .getByRole("button", { name: "Browse skills", exact: true })
      .click()
    await page.getByRole("button", { name: "Preview", exact: true }).waitFor()
    await page.evaluate(() => {
      window.skillFixture.hold = "/skills/import/read"
    })
    await page.getByRole("button", { name: "Preview", exact: true }).click()
    await page.waitForFunction(() => window.skillFixture.pending.length === 1)
    await page.getByRole("button", { name: "Cancel", exact: true }).click()
    await page.waitForFunction(() => window.skillFixture.aborted === 1)
    await page.evaluate(() => {
      const f = window.skillFixture
      f.pending[0]({
        name: f.hosted.name,
        body: "Late hosted body",
        source: {
          ...f.hosted,
          connectionId: f.tool.connectionId,
          connectionName: f.tool.connectionName,
          toolName: f.tool.name,
          files: ["SKILL.md"],
        },
      })
    })
    await page.waitForTimeout(30)
    assert.equal(
      await page.getByLabel("Instructions", { exact: true }).count(),
      0
    )
    assert.equal(
      await page.evaluate(
        () =>
          window.skillFixture.calls.filter((call) =>
            call.path.endsWith("/skills/save")
          ).length
      ),
      0
    )
  },
}
try {
  for (const [viewport, options] of Object.entries({
    desktop: { viewport: { width: 1280, height: 900 } },
    mobile: {
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    },
  })) {
    for (const [name, run] of Object.entries(cases)) {
      const page = await browser.newPage(options),
        errors = []
      page.setDefaultTimeout(8000)
      page.on("pageerror", (error) => errors.push(error.message))
      try {
        await fixture(page)
        await run(page)
        assert.deepEqual(errors, [])
        results.push({ viewport, name, passed: true })
        console.log(`PASS ${viewport}: ${name}`)
      } finally {
        await page.close()
      }
    }
  }
  console.log(
    JSON.stringify({
      component: "actual SkillsPanel",
      syntheticHttp: true,
      results,
    })
  )
} finally {
  await browser.close()
  await new Promise((resolve) => server.close(resolve))
}
