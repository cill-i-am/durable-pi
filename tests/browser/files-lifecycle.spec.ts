import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

// This small browser harness exercises the production hook and scoped actors;
// native fetch is held past abort to expose the owner/acknowledgement boundary.
const root = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve("alchemy"))("esbuild") as {
  build: (
    options: Record<string, unknown>
  ) => Promise<{ outputFiles: { text: string }[] }>
}
let server: Server
let address: string

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `import {useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';import {useFiles} from './src/features/files/use-files';function App(){const[agent,setAgent]=useState('alpha');const files=useFiles(agent);useEffect(()=>{window.probe={...files,setAgent}},[files]);return <pre id='value'>{JSON.stringify({agent,files:files.files,selected:files.selected,uploads:files.uploads.map(x=>({id:x.id,status:x.status})),uploading:files.uploading,error:files.error})}</pre>}createRoot(document.getElementById('root')).render(<App/>);`,
      resolveDir: root,
      loader: "tsx",
    },
    plugins:
      process.env.F03_BREAK_REFRESH_FENCE === "1"
        ? [
            {
              name: "negative-refresh-fence",
              setup(plugin: {
                onLoad: (
                  options: { filter: RegExp },
                  callback: (input: {
                    path: string
                  }) => Promise<{ contents: string; loader: string }>
                ) => void
              }) {
                plugin.onLoad(
                  { filter: /file-refresh\.machine\.ts$/ },
                  async ({ path }) => ({
                    contents: (await readFile(path, "utf8")).replaceAll(
                      "if (context.dirty)",
                      "if (false && context.dirty)"
                    ),
                    loader: "ts",
                  })
                )
              },
            },
          ]
        : [],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: `${root}/tsconfig.json`,
    define: { __PI_BUILD_REVISION__: JSON.stringify("a".repeat(40)) },
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
  if (!port || typeof port === "string") throw new Error("Missing fixture port")
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
      calls: {
        agent: string | null
        path: string
        id: unknown
        aborted: boolean
      }[]
      pending: ((fail?: boolean) => void)[]
      lists: (() => void)[]
      holdLists: boolean
      seeded?: Record<string, unknown[]>
      file: (agent: string) => unknown
    }
    const saved = new Map<string, unknown[]>()
    scope.calls = []
    scope.pending = []
    scope.lists = []
    scope.holdLists = false
    scope.file = (agent) => ({
      id:
        agent === "alpha"
          ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
          : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      name: `${agent}.txt`,
      mime: "text/plain",
      kind: "text",
      size: 1,
      createdAt: "2026-10-23T00:00:00Z",
      status: "ready",
      trashed: false,
    })
    window.fetch = async (input, options) => {
      const parsed = new URL(String(input), location.href),
        agent = parsed.searchParams.get("agent")!
      const call = {
        agent,
        path: parsed.pathname,
        id: options?.body instanceof FormData ? options.body.get("id") : null,
        aborted: false,
      }
      scope.calls.push(call)
      options?.signal?.addEventListener("abort", () => {
        call.aborted = true
      })
      if (parsed.pathname.endsWith("/upload"))
        return new Promise((resolve, reject) =>
          scope.pending.push((fail) => {
            if (fail) {
              reject(new Error("Connection interrupted"))
              return
            }
            const file = scope.file(agent)
            saved.set(agent, [file])
            resolve(Response.json(file))
          })
        )
      const files =
        saved.get(agent) ??
        scope.seeded?.[agent] ??
        (agent === "beta" ? [scope.file(agent)] : [])
      if (scope.holdLists)
        return new Promise((resolve) =>
          scope.lists.push(() => resolve(Response.json({ files })))
        )
      return Response.json({ files })
    }
  })
  await page.goto(address)
  await page.waitForFunction(() => {
    const value = (window as unknown as { probe?: { loading: boolean } }).probe
    return value && !value.loading
  })
})

// A locally typed aperture keeps the synthetic transport controls out of the app.
type Probe = {
  probe: {
    agentId: string
    upload: (files: File[], attach: boolean) => Promise<void>
    retry: (attempt: unknown) => Promise<void>
    uploads: unknown[]
    uploading: boolean
    loading: boolean
    refresh: () => Promise<void>
    setAgent: (agent: string) => void
  }
  calls: { agent: string; path: string; id: string; aborted: boolean }[]
  pending: ((fail?: boolean) => void)[]
  lists: (() => void)[]
  holdLists: boolean
  seeded?: Record<string, unknown[]>
  file: (agent: string) => object
}

test("duplicate upload stays single and uncertain retry keeps the original reservation", async ({
  page,
}) => {
  await page.evaluate(() => {
    const scope = window as unknown as Probe,
      file = new File(["a"], "same.txt", { type: "text/plain" })
    void scope.probe.upload([file], true)
    void scope.probe.upload([file], true)
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).pending.length === 1
  )
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Probe).calls.filter((call) =>
          call.path.endsWith("/upload")
        ).length
    )
  ).toBe(1)
  await page.evaluate(() => (window as unknown as Probe).pending.shift()!(true))
  await page.waitForFunction(
    () => !(window as unknown as Probe).probe.uploading
  )
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    void scope.probe.retry(scope.probe.uploads[0])
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).pending.length === 1
  )
  const ids = await page.evaluate(() =>
    (window as unknown as Probe).calls
      .filter((call) => call.path.endsWith("/upload"))
      .map((call) => call.id)
  )
  expect(ids).toHaveLength(2)
  expect(ids[1]).toBe(ids[0])
  await page.evaluate(() => (window as unknown as Probe).pending.shift()!())
  await expect(page.locator("#value")).toContainText(
    '"selected":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'
  )
})

test("late upload completion cannot replace the new agent's files or draft selection", async ({
  page,
}) => {
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    void scope.probe.upload([new File(["a"], "same.txt")], true)
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).pending.length === 1
  )
  await page.evaluate(() => (window as unknown as Probe).probe.setAgent("beta"))
  await page.waitForFunction(() => {
    const scope = window as unknown as Probe
    return scope.probe.agentId === "beta" && !scope.probe.loading
  })
  await page.waitForFunction(() =>
    (window as unknown as Probe).calls.some(
      (call) => call.path.endsWith("/upload") && call.aborted
    )
  )
  await page.evaluate(() => (window as unknown as Probe).pending.shift()!())
  await expect(page.locator("#value")).toContainText(
    '"files":[{"id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"'
  )
  await expect(page.locator("#value")).toContainText('"selected":[]')
  await expect(page.locator("#value")).not.toContainText(
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  )
})

test("a pre-upload list response cannot erase the published file while the fresh read is held", async ({
  page,
}) => {
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    scope.holdLists = true
    void scope.probe.refresh()
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).lists.length === 1
  )
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    void scope.probe.upload([new File(["a"], "same.txt")], true)
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).pending.length === 1
  )
  await page.evaluate(() => (window as unknown as Probe).pending.shift()!())
  await expect(page.locator("#value")).toContainText(
    '"files":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'
  )
  await page.evaluate(() => (window as unknown as Probe).lists.shift()!())
  await page.waitForFunction(() => {
    const scope = window as unknown as Probe
    return !scope.probe.loading || scope.lists.length === 1
  })
  await expect(page.locator("#value")).toContainText(
    '"files":[{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"'
  )
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    scope.holdLists = false
    scope.lists.shift()!()
  })
  await page.waitForFunction(() => !(window as unknown as Probe).probe.loading)
})

test("a restored pending reservation keeps its backend identity when the user chooses the file again", async ({
  page,
}) => {
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    scope.seeded = {
      alpha: [
        { ...scope.file("alpha"), name: "same.txt", status: "uploading" },
      ],
    }
    return scope.probe.refresh()
  })
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    void scope.probe.upload([new File(["a"], "same.txt")], true)
  })
  await page.waitForFunction(
    () => (window as unknown as Probe).pending.length === 1
  )
  const ids = await page.evaluate(() =>
    (window as unknown as Probe).calls
      .filter((call) => call.path.endsWith("/upload"))
      .map((call) => call.id)
  )
  expect(ids).toEqual(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"])
  await page.evaluate(() => (window as unknown as Probe).pending.shift()!())
  await page.waitForFunction(
    () => !(window as unknown as Probe).probe.uploading
  )
})

test("capacity rejection sends no upload and explicit refresh clears the shared error", async ({
  page,
}) => {
  await page.evaluate(() => {
    const scope = window as unknown as Probe
    return scope.probe.upload(
      Array.from({ length: 5 }, (_, index) => new File(["a"], `${index}.txt`)),
      true
    )
  })
  await expect(page.locator("#value")).toContainText(
    "Choose up to 4 more files."
  )
  expect(
    await page.evaluate(
      () =>
        (window as unknown as Probe).calls.filter((call) =>
          call.path.endsWith("/upload")
        ).length
    )
  ).toBe(0)
  await page.evaluate(() => (window as unknown as Probe).probe.refresh())
  await expect(page.locator("#value")).toContainText('"error":""')
})
