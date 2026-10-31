import { readFile } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

import { expect, test } from "@playwright/test"

const root = fileURLToPath(new URL("../../", import.meta.url))
const require = createRequire(import.meta.url)
const { build } = createRequire(require.resolve("alchemy"))("esbuild") as {
  build: (
    options: Record<string, unknown>
  ) => Promise<{ outputFiles: { text: string }[] }>
}
let server: Server, address: string

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `import {useState} from 'react';import {createRoot} from 'react-dom/client';import {useFiles} from './src/features/files/use-files';import {MessageFileControls} from './src/features/files/message-file-controls';function App(){const[agent,setAgent]=useState('alpha');const files=useFiles(agent);return <><button onClick={()=>setAgent('beta')}>Switch agent</button><MessageFileControls files={files} sending={false}/><output data-testid='selection'>{files.selected.map(file=>file.name).join(',')}</output></>}createRoot(document.getElementById('root')).render(<App/>);`,
    },
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    loader: { ".css": "empty" },
    tsconfig: `${root}/tsconfig.json`,
    define: { __PI_BUILD_REVISION__: JSON.stringify("a".repeat(40)) },
    plugins: [
      {
        name: "hold-files-owner-publication",
        setup(builder: {
          onLoad: (
            filter: { filter: RegExp },
            callback: (input: {
              path: string
            }) => Promise<{ contents: string; loader: "tsx" }>
          ) => void
        }) {
          builder.onLoad({ filter: /use-files\.ts$/ }, async ({ path }) => {
            const source = await readFile(path, "utf8")
            let changed = source.replace(
              "const owner = yield* makeFilesOwner(agentId, cache)",
              "const owner = yield* makeFilesOwner(agentId, cache); yield* Effect.promise(() => new Promise(resolve => window.fileControlOwners.push({agentId, release: () => resolve(undefined)})))"
            )
            if (changed === source)
              throw new Error("Owner publication gate did not match")
            const brokenReadiness = process.env.BREAK_FILES_CONTROL_READINESS
            if (brokenReadiness === "1" || brokenReadiness === "cache") {
              const broken = changed.replace(
                "ready: owner !== null",
                brokenReadiness === "cache"
                  ? "ready: live !== null"
                  : "ready: true"
              )
              if (broken === changed)
                throw new Error("Readiness negative control did not match")
              changed = broken
            }
            return { contents: changed, loader: "tsx" }
          })
        },
      },
    ],
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

type Probe = {
  fileControlOwners: { agentId: string; release: () => void }[]
  fileControlUploads: { agentId: string; name: string }[]
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as Probe
    scope.fileControlOwners = []
    scope.fileControlUploads = []
    const saved = new Map<string, unknown[]>()
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.href)
      const agentId = url.searchParams.get("agent")!
      if (url.pathname.endsWith("/upload")) {
        const body = options!.body as FormData
        const chosen = body.get("file") as File
        scope.fileControlUploads.push({ agentId, name: chosen.name })
        const file = {
          id: body.get("id"),
          name: chosen.name,
          mime: chosen.type,
          kind: "text",
          size: chosen.size,
          createdAt: "2026-10-31T08:14:00Z",
          status: "ready",
          trashed: false,
        }
        saved.set(agentId, [file])
        return Response.json(file)
      }
      return Response.json({ files: saved.get(agentId) ?? [] })
    }
  })
  await page.goto(address)
  await page.waitForFunction(() =>
    (window as unknown as Probe).fileControlOwners.some(
      (owner) => owner.agentId === "alpha"
    )
  )
})

test("file and voice controls wait for the actual scoped owner before accepting a file", async ({
  page,
}) => {
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeDisabled()
  await expect(page.getByLabel("Choose files", { exact: true })).toHaveCount(0)
  await page.evaluate(() =>
    (window as unknown as Probe).fileControlOwners[0]!.release()
  )
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true })
  ).toBeEnabled()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: "alpha.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("owned file"),
  })
  await expect(page.getByTestId("selection")).toHaveText("alpha.txt")
  expect(
    await page.evaluate(() => (window as unknown as Probe).fileControlUploads)
  ).toEqual([{ agentId: "alpha", name: "alpha.txt" }])
})

test("a late former owner cannot enable the next agent's upload controls", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as Probe).fileControlOwners.some(
      (owner) => owner.agentId === "beta"
    )
  )
  await page.evaluate(() =>
    (window as unknown as Probe).fileControlOwners
      .find((owner) => owner.agentId === "alpha")!
      .release()
  )
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeDisabled()
  await expect(page.getByLabel("Choose files", { exact: true })).toHaveCount(0)
  await page.evaluate(() =>
    (window as unknown as Probe).fileControlOwners
      .find((owner) => owner.agentId === "beta")!
      .release()
  )
  await expect(
    page.getByRole("button", { name: "Attach files", exact: true })
  ).toBeEnabled()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: "beta.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("next owner"),
  })
  await expect(page.getByTestId("selection")).toHaveText("beta.txt")
  expect(
    await page.evaluate(() => (window as unknown as Probe).fileControlUploads)
  ).toEqual([{ agentId: "beta", name: "beta.txt" }])
})

test("published former-owner state cannot admit a file for the next agent", async ({
  page,
}) => {
  const attach = page.getByRole("button", { name: "Attach files", exact: true })
  await page.evaluate(() =>
    (window as unknown as Probe).fileControlOwners[0]!.release()
  )
  await expect(attach).toBeEnabled()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: "alpha.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("first owner"),
  })
  await expect(page.getByTestId("selection")).toHaveText("alpha.txt")
  await expect(attach).toBeEnabled()
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await page.waitForFunction(() =>
    (window as unknown as Probe).fileControlOwners.some(
      (owner) => owner.agentId === "beta"
    )
  )
  await expect(attach).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeDisabled()
  await expect(page.getByLabel("Choose files", { exact: true })).toHaveCount(0)
  await expect(page.getByTestId("selection")).toHaveText("")
  await page.evaluate(() =>
    (window as unknown as Probe).fileControlOwners
      .find((owner) => owner.agentId === "beta")!
      .release()
  )
  await expect(attach).toBeEnabled()
  await page.getByLabel("Choose files", { exact: true }).setInputFiles({
    name: "beta.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("second owner"),
  })
  await expect(page.getByTestId("selection")).toHaveText("beta.txt")
  expect(
    await page.evaluate(() => (window as unknown as Probe).fileControlUploads)
  ).toEqual([
    { agentId: "alpha", name: "alpha.txt" },
    { agentId: "beta", name: "beta.txt" },
  ])
})
