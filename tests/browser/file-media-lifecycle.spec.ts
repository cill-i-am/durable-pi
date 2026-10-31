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
  const bundle = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
      import {useState,useEffect} from 'react';import {createRoot} from 'react-dom/client';
      import {VoiceRecorder} from './src/features/files/voice-recorder';import {AudioPlayer} from './src/features/files/audio-player';
      import {FilePreview,FileDetails} from './src/features/files/files-panel';
      function App(){const[agent,setAgent]=useState('alpha'),[shown,setShown]=useState(true),[kind,setKind]=useState('text');
      const file={id:'same-file',name:agent+'.txt',kind,mime:'text/plain',size:8,status:'ready',trashed:false,createdAt:'2026-10-23T00:00:00Z',video:{status:'ready'}};
      useEffect(()=>{window.mediaApp={setAgent,setShown,setKind}},[]);
      return <><button onClick={()=>setAgent('beta')}>Switch agent</button><button onClick={()=>setShown(false)}>Unmount media</button>
      {shown&&<><VoiceRecorder key={agent} disabled={false} onRecorded={async(file)=>{window.recorded.push({name:file.name,text:await file.text()})}}/>
      <FileDetails key={'detail-'+agent} active={true} file={file} state={{agentId:agent,mutate:(id,action,name)=>new Promise(resolve=>window.mutations.push({agent,id,action,name,resolve}))}} onPendingChange={pending=>{window.detailPending=pending}} onAttach={()=>{}} disabled={false}/>
      <AudioPlayer file={{...file,kind:'audio'}} agentId={agent}/><FilePreview file={file} agentId={agent} view='source' onViewChange={()=>{}}/></>}</>}
      createRoot(document.getElementById('root')).render(<App/>);`,
    },
    bundle: true,
    loader: { ".css": "empty" },
    write: false,
    platform: "browser",
    format: "iife",
    tsconfig: `${root}/tsconfig.json`,
    define: { __PI_BUILD_REVISION__: JSON.stringify("a".repeat(40)) },
    plugins: [
      {
        name: "test-only-exports",
        setup(builder: {
          onLoad: (
            filter: { filter: RegExp },
            callback: (args: {
              path: string
            }) => Promise<{ contents: string; loader: "tsx" }>
          ) => void
        }) {
          builder.onLoad({ filter: /files-panel\.tsx$/ }, async ({ path }) => ({
            contents:
              (await readFile(path, "utf8")) +
              "\nexport {FilePreview,FileDetails};",
            loader: "tsx",
          }))
          if (process.env.F03_NEGATIVE_RELEASE)
            builder.onLoad(
              { filter: /voice-capture\.ts$/ },
              async ({ path }) => {
                const source = await readFile(path, "utf8"),
                  changed = source.replace("track.stop()", "undefined")
                if (changed === source)
                  throw new Error(
                    "Negative control did not match the track release"
                  )
                return { contents: changed, loader: "tsx" }
              }
            )
        },
      },
    ],
  })
  server = createServer((request, response) => {
    if (request.url?.includes("/content")) {
      response.writeHead(204)
      response.end()
      return
    }
    response.setHeader(
      "Content-Type",
      request.url === "/bundle.js" ? "text/javascript" : "text/html"
    )
    response.end(
      request.url === "/bundle.js"
        ? bundle.outputFiles[0]!.text
        : '<div id="root"></div><script src="/bundle.js"></script>'
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const bound = server.address()
  if (!bound || typeof bound === "string") throw new Error("No fixture port")
  address = `http://127.0.0.1:${bound.port}`
})
test.afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    )
)

type Probe = {
  detailPending: boolean
  mutations: {
    agent: string
    id: string
    action: string
    name: string
    resolve: (accepted: boolean) => void
  }[]
  micCalls: number
  trackStops: number
  recorders: number
  mode: "deferred" | "immediate" | "denied"
  holdStop: boolean
  permission: (() => void)[]
  stopRecorder: (() => void)[]
  recorded: { name: string; text: string }[]
  reads: {
    agent: string
    kind: string
    aborted: boolean
    release: (text: string) => void
  }[]
  mediaApp: {
    setAgent: (agent: string) => void
    setShown: (shown: boolean) => void
    setKind: (kind: string) => void
  }
}
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const scope = window as unknown as Probe
    scope.micCalls = 0
    scope.trackStops = 0
    scope.recorders = 0
    scope.mode = "deferred"
    scope.holdStop = false
    scope.permission = []
    scope.stopRecorder = []
    scope.recorded = []
    scope.reads = []
    scope.mutations = []
    scope.detailPending = false
    Object.defineProperty(navigator, "mediaDevices", {
      value: {
        getUserMedia: () => {
          scope.micCalls++
          if (scope.mode === "denied")
            return Promise.reject(
              new DOMException("Microphone denied", "NotAllowedError")
            )
          const stream = {
            getTracks: () => [
              {
                stop: () => {
                  scope.trackStops++
                },
              },
            ],
          }
          return scope.mode === "immediate"
            ? Promise.resolve(stream)
            : new Promise((resolve) =>
                scope.permission.push(() => resolve(stream))
              )
        },
      },
    })
    class Recorder {
      state = "inactive"
      mimeType = "audio/ogg"
      ondataavailable: ((event: { data: Blob }) => void) | null = null
      onstop: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor() {
        scope.recorders++
      }
      static isTypeSupported() {
        return true
      }
      start() {
        this.state = "recording"
      }
      stop() {
        this.state = "inactive"
        const done = () => {
          this.ondataavailable?.({
            data: new Blob(["final voice chunk"], { type: "audio/ogg" }),
          })
          this.onstop?.()
        }
        if (scope.holdStop) scope.stopRecorder.push(done)
        else queueMicrotask(done)
      }
    }
    Object.defineProperty(window, "MediaRecorder", { value: Recorder })
    window.fetch = async (input, options) => {
      const url = new URL(String(input), location.href),
        agent = url.searchParams.get("agent")!,
        kind = url.pathname.endsWith("/video")
          ? "video"
          : url.searchParams.has("offset")
            ? "transcript"
            : "text"
      return new Promise((resolve) => {
        const call = {
          agent,
          kind,
          aborted: false,
          release: (text: string) =>
            resolve(
              Response.json(
                kind === "video"
                  ? {
                      duration: 1,
                      frames: [{ at: 0, jpeg: "AAAA" }],
                      captions: text,
                      captionsTruncated: false,
                    }
                  : { text, next: null }
              )
            ),
        }
        options?.signal?.addEventListener("abort", () => {
          call.aborted = true
        })
        scope.reads.push(call)
      })
    }
  })
  await page.goto(address)
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
})

test("cancelled acquisition prevents restart until the late stream is released", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByText("Opening microphone…", { exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Cancel voice recording", exact: true })
    .click()
  await expect(
    page.getByText("Releasing microphone…", { exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toHaveCount(0)
  expect(await page.evaluate(() => (window as unknown as Probe).micCalls)).toBe(
    1
  )
  await page.evaluate(() => (window as unknown as Probe).permission.shift()!())
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
  expect(
    await page.evaluate(() => ({
      stops: (window as unknown as Probe).trackStops,
      recorders: (window as unknown as Probe).recorders,
      uploads: (window as unknown as Probe).recorded.length,
    }))
  ).toEqual({ stops: 1, recorders: 0, uploads: 0 })
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).micCalls))
    .toBe(2)
})
test("finish waits for native final data before releasing and uploading once", async ({
  page,
}) => {
  await page.evaluate(() => {
    const p = window as unknown as Probe
    p.mode = "immediate"
    p.holdStop = true
  })
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByRole("button", { name: "Finish voice message", exact: true })
  ).toBeEnabled()
  await page
    .getByRole("button", { name: "Finish voice message", exact: true })
    .click()
  await expect(
    page.getByText("Finishing recording…", { exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(() => (window as unknown as Probe).recorded)
  ).toEqual([])
  await page.evaluate(() =>
    (window as unknown as Probe).stopRecorder.shift()!()
  )
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
  expect(
    await page.evaluate(() => (window as unknown as Probe).recorded)
  ).toEqual([{ name: "voice-message.ogg", text: "final voice chunk" }])
  expect(
    await page.evaluate(() => (window as unknown as Probe).trackStops)
  ).toBe(1)
})
test("unmount joins late permission without recording or uploading", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByText("Opening microphone…", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Unmount media", exact: true }).click()
  await page.evaluate(() => (window as unknown as Probe).permission.shift()!())
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).trackStops))
    .toBe(1)
  expect(
    await page.evaluate(() => (window as unknown as Probe).recorded)
  ).toEqual([])
  expect(
    await page.evaluate(() => (window as unknown as Probe).recorders)
  ).toBe(0)
})
test("denied microphone retains an enabled explicit retry", async ({
  page,
}) => {
  await page.evaluate(() => {
    ;(window as unknown as Probe).mode = "denied"
  })
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(page.getByRole("alert")).toContainText("Microphone denied")
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
})
test("transcript and text previews fence late results across the same file ID on another agent", async ({
  page,
}) => {
  await page.getByText("Transcript", { exact: true }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).reads.length))
    .toBe(2)
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Probe).reads.filter(
            (r) => r.agent === "alpha" && r.aborted
          ).length
      )
    )
    .toBe(2)
  await page.getByText("Transcript", { exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Probe).reads.filter((r) => r.agent === "beta")
            .length
      )
    )
    .toBe(2)
  await page.evaluate(() => {
    for (const r of (window as unknown as Probe).reads.filter(
      (r) => r.agent === "beta"
    ))
      r.release(`beta ${r.kind}`)
  })
  await expect(page.getByText("beta transcript", { exact: true })).toBeVisible()
  await expect(page.getByText("beta text", { exact: true })).toBeVisible()
  await page.evaluate(() => {
    for (const r of (window as unknown as Probe).reads.filter(
      (r) => r.agent === "alpha"
    ))
      r.release(`stale alpha ${r.kind}`)
  })
  await expect(page.getByText(/stale alpha/)).toHaveCount(0)
  await expect(page.locator("audio")).toHaveAttribute("src", /agent=beta/)
})
test("video preview clears prior frames and aborts pending resources on unmount", async ({
  page,
}) => {
  await page.evaluate(() =>
    (window as unknown as Probe).mediaApp.setKind("video")
  )
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Probe).reads.filter((r) => r.kind === "video")
            .length
      )
    )
    .toBe(1)
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as Probe).reads.filter((r) => r.kind === "video")
            .length
      )
    )
    .toBe(2)
  await page.evaluate(() => {
    ;(window as unknown as Probe).reads
      .find((r) => r.kind === "video" && r.agent === "beta")!
      .release("beta frames")
  })
  await page.getByText("Embedded captions", { exact: true }).click()
  await expect(page.getByText("beta frames", { exact: true })).toBeVisible()
  await page.evaluate(() => {
    ;(window as unknown as Probe).reads
      .find((r) => r.kind === "video" && r.agent === "alpha")!
      .release("stale alpha frames")
  })
  await expect(
    page.getByText("stale alpha frames", { exact: true })
  ).toHaveCount(0)
  await page.getByRole("button", { name: "Unmount media", exact: true }).click()
  await expect(page.locator("audio")).toHaveCount(0)
})
test("switching agents waits for the previous microphone owner before a new acquisition", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByText("Opening microphone…", { exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await page
    .getByRole("button", { name: "Record voice message", exact: true })
    .click()
  await expect(
    page.getByText("Opening microphone…", { exact: true })
  ).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as Probe).micCalls)).toBe(
    1
  )
  await page.evaluate(() => (window as unknown as Probe).permission.shift()!())
  await expect
    .poll(() => page.evaluate(() => (window as unknown as Probe).micCalls))
    .toBe(2)
  expect(
    await page.evaluate(() => (window as unknown as Probe).trackStops)
  ).toBe(1)
  await page
    .getByRole("button", { name: "Cancel voice recording", exact: true })
    .click()
  await page.evaluate(() => (window as unknown as Probe).permission.shift()!())
  await expect(
    page.getByRole("button", { name: "Record voice message", exact: true })
  ).toBeEnabled()
  expect(
    await page.evaluate(() => (window as unknown as Probe).trackStops)
  ).toBe(2)
})
test("rename owns one immutable command, retains rejected edits and fences a former agent", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Options for alpha.txt", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click()
  await page.getByLabel("File name", { exact: true }).fill("renamed.txt")
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save", exact: true })
  ).toBeDisabled()
  await expect(
    page.getByRole("button", { name: "Cancel", exact: true })
  ).toBeDisabled()
  expect(
    await page.evaluate(() =>
      (window as unknown as Probe).mutations.map(({ agent, action, name }) => ({
        agent,
        action,
        name,
      }))
    )
  ).toEqual([{ agent: "alpha", action: "rename", name: "renamed.txt" }])
  await page.evaluate(() =>
    (window as unknown as Probe).mutations[0]!.resolve(false)
  )
  await expect(
    page.getByRole("button", { name: "Save", exact: true })
  ).toBeEnabled()
  await expect(page.getByLabel("File name", { exact: true })).toHaveValue(
    "renamed.txt"
  )
  await page.getByRole("button", { name: "Save", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Save", exact: true })
  ).toBeDisabled()
  await page.getByRole("button", { name: "Switch agent", exact: true }).click()
  await expect(
    page.getByRole("button", { name: "Options for beta.txt", exact: true })
  ).toBeEnabled()
  await page.evaluate(() =>
    (window as unknown as Probe).mutations[1]!.resolve(true)
  )
  await expect(
    page.getByRole("button", { name: "Options for beta.txt", exact: true })
  ).toBeEnabled()
  await expect(page.getByLabel("File name", { exact: true })).toHaveCount(0)
})
