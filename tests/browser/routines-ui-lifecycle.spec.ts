import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

type ProbeWindow = Window & {
  calls: { agent: string; path: string; body: unknown; aborted: boolean }[]
  pending: ((mode?: "fail" | "newer") => void)[]
  probe: { setAgent: (agent: string) => void; setView: (view: string) => void }
}

const root = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve("alchemy"))("esbuild") as {
  build: (
    input: Record<string, unknown>
  ) => Promise<{ outputFiles: { text: string }[] }>
}
let server: Server, address: string

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import{useState,useEffect}from'react';import{createRoot}from'react-dom/client';import{useRoutines}from'./src/features/routines/use-routines';import{useWebhook}from'./src/features/routines/use-webhook';import{RoutinesWorkbench}from'./src/features/routines/routines-workbench';const id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';function App(){const[agent,setAgent]=useState('alpha'),[view,setView]=useState('A'),[applied,setApplied]=useState(0);const routines=useRoutines(agent,()=>setApplied(n=>n+1),()=>{},view),hook=useWebhook(agent,id,()=>{});const change={path:'status',body:{id,operationId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',expectedRevision:1,status:'paused'}};const configure={routineId:id,operationId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',expectedRevision:1,key:'rpwh_'+'a'.repeat(64)};useEffect(()=>{window.probe={routines,hook,setAgent,setView,change,configure}},[routines,hook,view]);return <><button onClick={()=>routines.send(change)}>Save</button><button onClick={()=>routines.retry()} disabled={!routines.attempt||routines.busy}>Retry same change</button><button onClick={()=>routines.stop(id)}>Stop</button><button onClick={()=>hook.send(configure)}>Configure</button><button onClick={()=>hook.retry()} disabled={!hook.attempt||hook.busy}>Retry webhook</button><button onClick={()=>hook.resolve()} disabled={!hook.attempt||hook.busy}>Resolve webhook</button><pre id='value'>{JSON.stringify({agent,view,applied,routines:{data:routines.data,busy:routines.busy,attempt:routines.attempt,stopId:routines.stopId,error:routines.error},hook:{info:hook.info,key:hook.key,attempt:hook.attempt,busy:hook.busy}})}</pre></>}function UIApp(){const[selected,setSelected]=useState(null),[webhook,setWebhook]=useState(false);return <RoutinesWorkbench agentId='alpha' selected={selected} webhook={webhook} onSelect={(id,hook=false)=>{setSelected(id);setWebhook(hook)}} onPendingChange={()=>{}}/>}createRoot(document.getElementById('root')).render(location.search.includes('ui')?<UIApp/>:<App/>);`,
      resolveDir: root,
      loader: "tsx",
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: `${root}/tsconfig.json`,
    plugins:
      process.env.F12_BREAK_VIEW_FENCE === "1"
        ? [
            {
              name: "negative-view-fence",
              setup(plugin: {
                onLoad: (
                  options: { filter: RegExp },
                  callback: (input: {
                    path: string
                  }) => Promise<{ contents: string; loader: string }>
                ) => void
              }) {
                plugin.onLoad(
                  { filter: /routines-ui\.machine\.ts$/ },
                  async ({ path }) => ({
                    contents: (await readFile(path, "utf8")).replaceAll(
                      "context.viewRevision === context.admittedViewRevision",
                      "true"
                    ),
                    loader: "ts",
                  })
                )
              },
            },
          ]
        : [],
  })
  server = createServer((request, response) => {
    response.setHeader(
      "Content-Type",
      request.url === "/bundle.js" ? "text/javascript" : "text/html"
    )
    response.end(
      request.url === "/bundle.js"
        ? result.outputFiles[0]!.text
        : '<div id="root"></div><script src="/bundle.js"></script>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = server.address()
  if (!port || typeof port === "string") throw new Error("No fixture port")
  address = `http://127.0.0.1:${port.port}`
})
test.afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
)

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as {
      calls: { agent: string; path: string; body: unknown; aborted: boolean }[]
      pending: ((mode?: "fail" | "newer") => void)[]
    }
    scope.calls = []
    scope.pending = []
    const routines = new Map<string, unknown[]>(),
      hooks = new Map<
        string,
        {
          routineId: string
          enabled: boolean
          revision: number
          accepted: number
        }
      >()
    const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const routine = (agent: string) => ({
      id,
      title: agent,
      prompt: "Read notes",
      schedule: { type: "webhook" },
      status: "active",
      revision: 1,
      nextAt: null,
      createdAt: 1,
      updatedAt: 1,
    })
    window.fetch = (input, options) => {
      const url = new URL(String(input), location.href),
        agent = url.searchParams.get("agent")!
      const body = options?.body ? JSON.parse(String(options.body)) : null
      const call = { agent, path: url.pathname, body, aborted: false }
      scope.calls.push(call)
      options?.signal?.addEventListener("abort", () => {
        call.aborted = true
      })
      const info = () =>
        hooks.get(agent) ?? {
          routineId: id,
          enabled: false,
          revision: 1,
          accepted: 0,
        }
      if (url.pathname.endsWith("/routines"))
        return Promise.resolve(
          Response.json({
            routines: routines.get(agent) ?? [routine(agent)],
            runs: [],
          })
        )
      if (url.pathname.endsWith("/webhooks"))
        return Promise.resolve(Response.json(info()))
      if (url.pathname.endsWith("/cancel"))
        return Promise.resolve(Response.json({ applied: true }))
      return new Promise((resolve, reject) =>
        scope.pending.push((mode) => {
          if (url.pathname.endsWith("/configure")) {
            const result = {
              routineId: id,
              enabled: !!body.key,
              revision: body.expectedRevision + 1,
              accepted: 0,
            }
            hooks.set(
              agent,
              mode === "newer"
                ? { ...result, revision: result.revision + 1 }
                : result
            )
            if (mode === "fail") reject(new Error("acknowledgement lost"))
            else resolve(Response.json(result))
          } else if (url.pathname.endsWith("/stop")) {
            if (mode === "fail") reject(new Error("Stop uncertain"))
            else resolve(Response.json({}))
          } else {
            const value = {
              ...routine(agent),
              title: body.title ?? agent,
              prompt: body.prompt ?? "Read notes",
              status: body.status,
              revision: 2,
            }
            routines.set(agent, [value])
            if (mode === "fail") reject(new Error("acknowledgement lost"))
            else resolve(Response.json({ routine: value, run: null }))
          }
        })
      )
    }
  })
  await page.goto(address)
  await expect(page.locator("#value")).toContainText('"title":"alpha"')
})

test("duplicate commands and a lost acknowledgement keep the exact request for explicit retry", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[0]!("fail")
  )
  await expect(
    page.getByRole("button", { name: "Retry same change" })
  ).toBeEnabled()
  await page.getByRole("button", { name: "Retry same change" }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(2)
  const bodies = await page.evaluate(() =>
    (window as unknown as ProbeWindow).calls
      .filter((call) => call.path.endsWith("/status"))
      .map((call) => call.body)
  )
  expect(bodies).toHaveLength(2)
  expect(bodies[1]).toEqual(bodies[0])
  await page.evaluate(() => (window as unknown as ProbeWindow).pending[1]!())
  await expect(page.locator("#value")).toContainText('"applied":1')
})
test("old agent completion aborts and cannot close the new agent editor or start another verification read", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await page.getByRole("button", { name: "Configure", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(2)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).probe.setAgent("beta")
  )
  await expect(page.locator("#value")).toContainText('"title":"beta"')
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as unknown as ProbeWindow).calls
          .filter((call) => call.body && call.agent === "alpha")
          .every((call) => call.aborted)
      )
    )
    .toBe(true)
  await page.evaluate(() => {
    ;(window as unknown as ProbeWindow).pending[0]!()
    ;(window as unknown as ProbeWindow).pending[1]!()
  })
  await page.waitForTimeout(30)
  await expect(page.locator("#value")).toContainText('"applied":0')
  await expect(page.locator("#value")).toContainText('"title":"beta"')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as ProbeWindow).calls.filter(
          (call) => call.agent === "alpha" && !call.body
        ).length
    )
  ).toBe(2)
})
test("A to B to A navigation cannot let an old save close the current editor", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).probe.setView("B")
  )
  await expect(page.locator("#value")).toContainText('"view":"B"')
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).probe.setView("A")
  )
  await expect(page.locator("#value")).toContainText('"view":"A"')
  await page.evaluate(() => (window as unknown as ProbeWindow).pending[0]!())
  await expect(page.locator("#value")).toContainText('"status":"paused"')
  await expect(page.locator("#value")).toContainText('"applied":0')
})
test("webhook retry preserves the secret and a newer revision prevents disclosure", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Configure", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[0]!("fail")
  )
  await page.getByRole("button", { name: "Retry webhook" }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(2)
  const bodies = await page.evaluate(() =>
    (window as unknown as ProbeWindow).calls
      .filter((call) => call.path.endsWith("/configure"))
      .map((call) => call.body)
  )
  expect(bodies[1]).toEqual(bodies[0])
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[1]!("newer")
  )
  await expect(page.locator("#value")).toContainText('"revision":3')
  await expect(page.locator("#value")).toContainText('"key":null')
})
test("resolve reads the current webhook before revealing the exact already-applied key", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Configure", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[0]!("fail")
  )
  await page.getByRole("button", { name: "Resolve webhook" }).click()
  await expect(page.locator("#value")).toContainText('"value":"rpwh_')
  expect(
    await page.evaluate(
      () =>
        (window as unknown as ProbeWindow).calls.find((call) =>
          call.path.endsWith("/cancel")
        )!.body
    )
  ).toEqual({ operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" })
})

test("actual routine editor retains a lost save until the explicit same-change retry completes", async ({
  page,
}) => {
  await page.goto(`${address}/?ui=1`)
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Reviewed routine")
  await page.getByRole("button", { name: "Save routine", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await expect(
    page.getByRole("button", { name: "Save routine", exact: true })
  ).toBeDisabled()
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[0]!("fail")
  )
  await expect(
    page.getByRole("button", { name: "Resolve and cancel" })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Retry same change", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(2)
  const bodies = await page.evaluate(() =>
    (window as unknown as ProbeWindow).calls
      .filter((call) => call.path.endsWith("/save"))
      .map((call) => call.body)
  )
  expect(bodies[1]).toEqual(bodies[0])
  await page.evaluate(() => (window as unknown as ProbeWindow).pending[1]!())
  await expect(
    page.getByRole("heading", { name: "Reviewed routine", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Save routine", exact: true })
  ).toHaveCount(0)
})

test("actual webhook controls retry the same generated key and hide it after a newer configuration", async ({
  page,
}) => {
  await page.goto(`${address}/?ui=1`)
  await page.getByRole("button", { name: "Webhook", exact: true }).click()
  await page
    .getByRole("button", { name: "Enable and create key", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(1)
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[0]!("fail")
  )
  await page
    .getByRole("button", { name: "Retry same change", exact: true })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => (window as unknown as ProbeWindow).pending.length)
    )
    .toBe(2)
  const bodies = await page.evaluate(() =>
    (window as unknown as ProbeWindow).calls
      .filter((call) => call.path.endsWith("/configure"))
      .map((call) => call.body)
  )
  expect(bodies[1]).toEqual(bodies[0])
  await page.evaluate(() =>
    (window as unknown as ProbeWindow).pending[1]!("newer")
  )
  await expect(
    page.getByRole("status").filter({ hasText: "changed again" })
  ).toBeVisible()
  await expect(page.getByLabel("New key · copy before leaving")).toHaveCount(0)
})
