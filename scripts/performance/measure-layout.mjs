import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import puppeteer from "@cloudflare/puppeteer"

const [endpoint, origin, output, screenshots] = process.argv
  .slice(2)
  .filter((arg) => !arg.startsWith("--"))
if (!endpoint || !origin || !output)
  throw new Error(
    "Usage: measure-layout.mjs <browser-websocket> <fixture-origin> <output.json> [screenshots-directory]"
  )
const assertStable = process.argv.includes("--assert-stable")
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint })
const samples = process.argv.includes("--resume")
  ? JSON.parse(await readFile(output, "utf8")).samples
  : []
const cases = [
  ...[320, 390, 767, 768, 1024, 1440].flatMap((width) =>
    ["/agents/home", "/agents/home/apps"].map((path) => ({
      width,
      height: 900,
      path,
    }))
  ),
  { width: 1440, height: 900, path: "/" },
  { width: 640, height: 450, path: "/agents/home", deviceScaleFactor: 2 },
  {
    width: 390,
    height: 844,
    path: "/agents/home",
    reducedMotion: true,
    dark: true,
  },
]
if (screenshots) await mkdir(screenshots, { recursive: true })
await mkdir(dirname(output), { recursive: true })
if (
  samples.some(
    (sample, i) => JSON.stringify(sample.scenario) !== JSON.stringify(cases[i])
  )
)
  throw new Error("Resume data does not match this viewport/route matrix")
for (const scenario of cases.slice(samples.length)) {
  const page = await browser.newPage()
  page.setDefaultTimeout(15_000)
  const held = new Map()
  const released = new Set()
  try {
    await page.setViewport({
      width: scenario.width,
      height: scenario.height,
      deviceScaleFactor: scenario.deviceScaleFactor ?? 1,
    })
    await page.setCacheEnabled(false)
    const cdp = await page.createCDPSession()
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
    await page.emulateMediaFeatures([
      {
        name: "prefers-reduced-motion",
        value: scenario.reducedMotion ? "reduce" : "no-preference",
      },
      { name: "prefers-color-scheme", value: scenario.dark ? "dark" : "light" },
    ])
    await page.evaluateOnNewDocument(() => {
      const shifts = []
      const workbenchWidths = []
      const panelFrames = []
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          if (!entry.hadRecentInput)
            shifts.push({
              at: entry.startTime,
              value: entry.value,
              sources: entry.sources?.map((s) => ({
                tag: s.node?.tagName,
                class:
                  typeof s.node?.className === "string" ? s.node.className : "",
                previous: s.previousRect,
                current: s.currentRect,
              })),
            })
      }).observe({ type: "layout-shift", buffered: true })
      const track = () => {
        const host = document.querySelector('.workbench-host[data-open="true"]')
        if (host) {
          const width =
            Math.round(host.getBoundingClientRect().width * 100) / 100
          if (width !== workbenchWidths.at(-1)) workbenchWidths.push(width)
        }
        const panel = document.querySelector(".workbench-sheet")
        if (panel && panel.getClientRects().length) {
          const rect = panel.getBoundingClientRect()
          const bounds = [rect.x, rect.y, rect.width, rect.height].map(
            (n) => Math.round(n * 100) / 100
          )
          if (
            bounds.some((value, index) => value !== panelFrames.at(-1)?.[index])
          )
            panelFrames.push(bounds)
        }
        requestAnimationFrame(track)
      }
      requestAnimationFrame(track)
      window.__layoutAudit = { shifts, workbenchWidths, panelFrames }
    })
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname
      if (
        [
          "/api/auth/get-session",
          "/api/agent/bots",
          "/api/agent/events",
        ].includes(path) &&
        !released.has(path)
      ) {
        const pending = held.get(path) ?? []
        pending.push(request)
        held.set(path, pending)
      } else void request.continue()
    })
    const release = async (path) => {
      released.add(path)
      for (const request of held.get(path) ?? []) await request.continue()
      held.delete(path)
    }
    const capture = async (stage) => {
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          )
      )
      return page.evaluate((stage) => {
        const root = document.querySelector('[data-slot="workspace-startup"]')
        const panel = innerWidth < 768 && location.pathname.endsWith("/apps")
        const rect = (selector) => {
          const e = [...document.querySelectorAll(selector)].find((node) => {
            const r = node.getBoundingClientRect()
            return node.getClientRects().length && r.width && r.height
          })
          if (!e) return null
          const r = e.getBoundingClientRect()
          if (!r.width || !r.height) return null
          return Object.fromEntries(
            ["x", "y", "width", "height"].map((k) => [
              k,
              Math.round(r[k] * 100) / 100,
            ])
          )
        }
        const legacy = root && !root.querySelector(".chat-header")
        const header =
          panel && document.querySelector(".workbench-header")
            ? ".workbench-header"
            : ".chat-header"
        const composer = root
          ? '[data-slot="workspace-startup"] > div > div:last-child > [data-slot="skeleton"]'
          : ".chat-composer"
        return {
          stage,
          at: performance.now(),
          timeOrigin: performance.timeOrigin,
          viewport: [innerWidth, innerHeight],
          path: location.pathname,
          startup: !!root,
          fonts: document.fonts.status,
          overflow: document.documentElement.scrollWidth > innerWidth,
          geometry: {
            bar: rect(".workspace-bar"),
            sidebar: rect(
              '.workspace-startup-sidebar, [data-slot="sidebar-container"]'
            ),
            header: rect(
              legacy
                ? '[data-slot="workspace-startup"] > div > div:first-child'
                : header
            ),
            composer: rect(
              document.querySelector(".chat-composer")
                ? ".chat-composer"
                : composer
            ),
            navigation: rect(".mobile-navigation"),
            workbench: rect(
              root
                ? '[data-slot="startup-workbench"]'
                : panel
                  ? ".workbench-sheet"
                  : '.workbench-host[data-open="true"]'
            ),
          },
          loadingStatuses:
            root?.querySelectorAll('[role="status"]').length ?? 0,
          loadingFocusTargets:
            root?.querySelectorAll(
              'button, input, textarea, a[href], [tabindex="0"]'
            ).length ?? 0,
          loadingAnimations: root
            ? [...root.querySelectorAll('[data-slot="skeleton"]')].filter(
                (e) => getComputedStyle(e).animationName !== "none"
              ).length
            : 0,
        }
      }, stage)
    }
    const waitMark = (name) =>
      page.waitForFunction(
        (name) => performance.getEntriesByName(`pi:${name}:ready`).length > 0,
        {},
        name
      )
    await page.goto(`${origin}${scenario.path}`, {
      waitUntil: "domcontentloaded",
    })
    await page.waitForSelector('[data-slot="workspace-startup"]')
    const stages = [await capture("session-pending")]
    const name = `${scenario.width}-${scenario.path === "/" ? "root" : scenario.path.endsWith("/apps") ? "workbench" : "chat"}${scenario.reducedMotion ? "-reduced-dark" : ""}`
    if (screenshots)
      await writeFile(
        `${screenshots}/${name}-loading.png`,
        await page.screenshot({ type: "png" })
      )
    await release("/api/auth/get-session")
    await waitMark("session")
    stages.push(await capture("catalog-pending"))
    await release("/api/agent/bots")
    await waitMark("catalog")
    stages.push(await capture("history-pending"))
    await release("/api/agent/events")
    await waitMark("snapshot")
    stages.push(await capture("metadata-pending"))
    await waitMark("history")
    await waitMark("models")
    await page.evaluate(() => document.fonts.ready)
    await new Promise((resolve) => setTimeout(resolve, 1000))
    stages.push(await capture("ready"))
    if (screenshots)
      await writeFile(
        `${screenshots}/${name}-ready.png`,
        await page.screenshot({ type: "png" })
      )
    const audit = await page.evaluate(() => {
      const { shifts, workbenchWidths, panelFrames } = window.__layoutAudit
      let max = 0,
        value = 0,
        first = 0,
        previous = 0
      for (const entry of shifts) {
        if (
          previous !== 0 &&
          entry.at - previous < 1000 &&
          entry.at - first < 5000
        )
          value += entry.value
        else {
          value = entry.value
          first = entry.at
        }
        previous = entry.at
        max = Math.max(max, value)
      }
      return {
        cls: max,
        shifts,
        workbenchWidths,
        panelFrames,
        responses: document.querySelectorAll(
          'button[aria-label="Copy response"]'
        ).length,
        composer: !!document.querySelector("textarea:not(:disabled)"),
      }
    })
    if (assertStable) {
      if (
        audit.cls > 0.01 ||
        !audit.composer ||
        audit.responses !== 20 ||
        stages.some((s) => s.overflow)
      )
        throw new Error(
          `${name}: readiness/overflow/CLS acceptance failed (${audit.cls})`
        )
      if (
        audit.panelFrames.length &&
        audit.panelFrames.some((frame) =>
          frame.some(
            (value, index) =>
              Math.abs(value - audit.panelFrames.at(-1)[index]) > 1
          )
        )
      )
        throw new Error(
          `${name}: workbench moved during its initial reveal: ${JSON.stringify(audit.panelFrames)}`
        )
      const final = stages.at(-1).geometry
      for (const stage of stages.slice(0, -1)) {
        if (
          stage.loadingStatuses !== 1 ||
          stage.loadingFocusTargets !== 0 ||
          (scenario.reducedMotion && stage.loadingAnimations !== 0)
        )
          throw new Error(
            `${name}/${stage.stage}: inaccessible or moving placeholder`
          )
        for (const [region, expected] of Object.entries(final)) {
          const actual = stage.geometry[region]
          if (
            (expected === null) !== (actual === null) ||
            (actual &&
              expected &&
              Object.keys(expected).some(
                (key) => Math.abs(actual[key] - expected[key]) > 1
              ))
          )
            throw new Error(
              `${name}/${stage.stage}/${region}: ${JSON.stringify(actual)} -> ${JSON.stringify(expected)}`
            )
        }
      }
    }
    const sample = { scenario, stages, ...audit }
    samples.push(sample)
    await writeFile(
      output,
      JSON.stringify(
        {
          protocol: {
            cpuSlowdown: 4,
            cache: "disabled",
            traffic: "synthetic read-only",
            stages:
              "hold session, catalog and history separately; metadata delayed 2200ms; settle fonts and 1000ms after models",
            cls: "maximum session window, gap <1000ms and length <5000ms; excludes recent input",
          },
          samples,
        },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        name,
        cls: audit.cls,
        ready: audit.composer && audit.responses === 20,
        overflow: stages.some((s) => s.overflow),
        initial: stages[0].geometry,
        final: stages.at(-1).geometry,
      })
    )
  } finally {
    // Release held requests before closing so interruption never strands a gate.
    for (const requests of held.values())
      for (const request of requests) await request.abort().catch(() => {})
    await page.close()
  }
}
await browser.disconnect()
