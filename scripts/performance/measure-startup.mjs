import { writeFile } from "node:fs/promises"
import puppeteer from "@cloudflare/puppeteer"

// Connect to an explicitly selected audit browser. Retain numeric timing and
// public asset paths only: never cookies, headers, query strings or bodies.
const [endpoint, beforeUrl, afterUrl, output, count = "10"] =
  process.argv.slice(2)
if (!endpoint || !beforeUrl || !afterUrl || !output)
  throw new Error(
    "Usage: measure-startup.mjs <browser-websocket> <before-url> <after-url> <output.json> [runs]"
  )
const runs = Number(count)
if (!Number.isInteger(runs) || runs < 1 || runs > 30)
  throw new Error("Use between 1 and 30 runs per condition")
const browser = await puppeteer.connect({ browserWSEndpoint: endpoint })
const page = await browser.newPage()
const cdp = await page.createCDPSession()
await page.setViewport({ width: 390, height: 844 })
await page.setCacheEnabled(false)
await cdp.send("Performance.enable")
await cdp.send("Network.enable")
await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 })
await cdp.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 150,
  downloadThroughput: 200_000,
  uploadThroughput: 93_750,
})
let requests = new Map()
cdp.on("Network.requestWillBeSent", (event) => {
  const url = new URL(event.request.url)
  if (url.protocol !== "http:" && url.protocol !== "https:") return
  requests.set(event.requestId, {
    path: url.pathname,
    type: event.type,
    start: event.timestamp,
    loader: event.loaderId,
  })
})
cdp.on("Network.responseReceived", (event) => {
  const request = requests.get(event.requestId)
  if (!request) return
  Object.assign(request, {
    status: event.response.status,
    headersAt: event.timestamp,
    cache: !!(event.response.fromDiskCache || event.response.fromServiceWorker),
  })
})
cdp.on("Network.dataReceived", (event) => {
  const request = requests.get(event.requestId)
  if (!request) return
  request.firstData ??= event.timestamp
  request.lastData = event.timestamp
  request.bytes = (request.bytes ?? 0) + event.dataLength
})
cdp.on("Network.loadingFinished", (event) => {
  const request = requests.get(event.requestId)
  if (!request) return
  request.end = event.timestamp
  request.transfer = event.encodedDataLength
})
const warmup = []
const samples = []
async function measure(condition, url) {
  requests = new Map()
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 })
  await page.waitForFunction(
    () => {
      const mark = performance.getEntriesByName("pi:models:ready")[0]
      return (
        mark &&
        performance.now() - mark.startTime >= 2000 &&
        document.fonts.status === "loaded"
      )
    },
    { timeout: 30_000 }
  )
  const sample = await page.evaluate(() => ({
    origin: location.origin,
    path: location.pathname,
    timeOrigin: performance.timeOrigin,
    visibility: document.visibilityState,
    marks: performance
      .getEntriesByType("mark")
      .filter((entry) => entry.name.startsWith("pi:"))
      .map((entry) => ({ name: entry.name, start: entry.startTime })),
    responses: document.querySelectorAll('button[aria-label="Copy response"]')
      .length,
    composer: !!document.querySelector("textarea:not(:disabled)"),
    startup: !!document.querySelector('[data-slot="workspace-startup"]'),
    overflow: document.documentElement.scrollWidth > innerWidth,
  }))
  if (
    sample.origin !== new URL(url).origin ||
    !sample.composer ||
    sample.startup ||
    sample.responses !== 20 ||
    sample.overflow ||
    sample.visibility !== "visible"
  )
    throw new Error("Startup did not satisfy the audit readiness contract")
  const { metrics } = await cdp.send("Performance.getMetrics")
  sample.metrics = Object.fromEntries(
    metrics
      .filter((metric) =>
        [
          "ScriptDuration",
          "LayoutDuration",
          "RecalcStyleDuration",
          "TaskDuration",
        ].includes(metric.name)
      )
      .map((metric) => [metric.name, metric.value])
  )
  const document = [...requests.values()].find(
    (request) => request.type === "Document"
  )
  sample.network = [...requests.values()]
    .filter((request) => request.loader === document?.loader)
    .map(({ loader: _, ...request }) => request)
  return { condition, ...sample }
}
const save = () =>
  writeFile(
    output,
    JSON.stringify(
      {
        protocol: {
          viewport: [390, 844],
          cpuSlowdown: 4,
          latencyMs: 150,
          downloadBytesPerSecond: 200_000,
          uploadBytesPerSecond: 93_750,
          cache: "disabled",
          settling: "2000ms after model readiness and fonts loaded",
        },
        warmup,
        samples,
      },
      null,
      2
    )
  )
try {
  for (const [condition, url] of [
    ["before", beforeUrl],
    ["after", afterUrl],
  ])
    warmup.push(await measure(condition, url))
  await save()
  for (let pair = 0; pair < runs; pair++) {
    const order =
      pair % 2 === 0
        ? [
            ["before", beforeUrl],
            ["after", afterUrl],
          ]
        : [
            ["after", afterUrl],
            ["before", beforeUrl],
          ]
    for (const [condition, url] of order) {
      const sample = await measure(condition, url)
      samples.push(sample)
      await save()
      console.log(
        JSON.stringify({
          run: pair + 1,
          condition,
          marks: sample.marks,
        })
      )
    }
  }
} finally {
  await page.close()
  await browser.disconnect()
}
