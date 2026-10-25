import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild")
const workerd = requireAlchemy("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-memory-summary-"))
const listener = createServer()
await new Promise((done) => listener.listen(0, "127.0.0.1", done))
const port = listener.address().port
await new Promise((done) => listener.close(done))
const origin = `http://127.0.0.1:${port}`
const broken = process.argv.includes("--break-uncertainty")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const pumpAttempts = (state) =>
  state.callbacks
    .filter((callback) => callback.job === "memory-compactor:pump")
    .map((callback) => callback.attempt)
let child,
  output = ""
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise((done) => child.once("exit", done))
  child.kill("SIGKILL")
  await stopped
}
async function start() {
  child = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
  )
  child.stdout.on("data", (chunk) => {
    output += chunk
  })
  child.stderr.on("data", (chunk) => {
    output += chunk
  })
  for (let n = 0; n < 100; n++) {
    if (child.exitCode !== null) throw new Error(output)
    try {
      if ((await fetch(origin + "/health")).ok) return
    } catch {}
    await sleep(50)
  }
  throw new Error(`Native summary fixture did not start: ${output}`)
}
async function request(path) {
  const response = await fetch(origin + path)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function until(name, test, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let state
  while (Date.now() < deadline) {
    state = await request(`/inspect?name=${name}`)
    if (test(state)) return state
    await sleep(100)
  }
  assert.fail(`${message}: ${JSON.stringify(state)}`)
}
try {
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/memory-summary-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    logLevel: "error",
    plugins: broken
      ? [
          {
            name: "break-cold-summary-uncertainty",
            setup(builder) {
              builder.onLoad(
                { filter: /\/memory\/summary\.machine\.ts$/ },
                async ({ path }) => {
                  const original = await readFile(path, "utf8")
                  const guard =
                    'RESTORE: ({ context }) => pause(context, "uncertain"),'
                  assert(
                    original.includes(guard),
                    "uncertainty mutation target changed"
                  )
                  return {
                    loader: "ts",
                    contents: original.replace(
                      guard,
                      'RESTORE: ({ context }) => ({ target: "retry", context: { ...change(context), owner: null, retryAt: 0, requestInFlight: false } }),'
                    ),
                  }
                }
              )
            },
          },
        ]
      : [],
  })
  const schema = join(
    dirname(requireAlchemy.resolve("workerd")),
    "..",
    "workerd.capnp"
  )
  await writeFile(
    join(directory, "fixture.capnp"),
    `using Workerd = import ${JSON.stringify(schema)};
const config :Workerd.Config = (
 services = [
  (name = "fixture", worker = (
   compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat", "enable_request_signal"],
   modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
   bindings = [(name = "PROBES", durableObjectNamespace = (className = "MemorySummaryProbe"))],
   durableObjectNamespaces = [(className = "MemorySummaryProbe", uniqueKey = "memory-summary-b13", enableSql = true)],
   durableObjectStorage = (localDisk = "storage")
  )),
  (name = "storage", disk = (path = "storage", writable = true))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const committed = await request("/admit?name=queued&mode=queued")
  assert.equal(committed.calls.length, 0)
  assert.equal(committed.controls[0].control.state, "queued")
  assert(
    committed.jobs.some((job) => job.id === "memory-compactor:discovery"),
    "admission retains its actual discovery job"
  )
  await request("/admit?name=uncertain&mode=uncertain")
  const interrupted = await until(
    "uncertain",
    (state) =>
      state.calls.length === 1 && state.controls[0]?.control.requestInFlight,
    "native request must debit and start"
  )
  const originalClaim = interrupted.calls[0].claim
  const originalRoute = interrupted.routes[0]
  const originalPumpToken = interrupted.jobs.find(
    (job) => job.id === "memory-compactor:pump"
  ).payload.token
  const beforeRestartCallback = interrupted.callbacks.at(-1)?.id ?? 0
  await request("/crash-window?name=uncertain")
  await stop()
  await start()
  // No object request or status probe starts recovery. Only independent /health ran.
  await sleep(2200)
  const recovered = await request("/inspect?name=queued")
  assert.equal(
    recovered.nodes.length,
    1,
    "retained alarm must complete accepted work without a poke"
  )
  assert(
    recovered.metrics.alarms > 0,
    "recovery must have run from the native alarm before inspection"
  )
  assert.equal(recovered.calls.length, 1)
  assert.deepEqual(recovered.originals, committed.originals)
  const paused = await request("/inspect?name=uncertain")
  assert(
    paused.metrics.alarms > interrupted.metrics.alarms,
    "uncertain claim restoration must run from retained alarm before inspection"
  )
  assert.equal(
    paused.controls[0]?.control.state,
    "paused",
    "cold uncertainty must pause rather than redispatch"
  )
  assert.equal(paused.controls[0].control.pauseReason, "uncertain")
  assert.equal(
    paused.calls.length,
    1,
    "unknown native work must never be automatically replayed"
  )
  assert.deepEqual(paused.calls[0].claim, originalClaim)
  assert.deepEqual(paused.routes[0], originalRoute)
  assert.deepEqual(paused.originals, interrupted.originals)
  assert(
    paused.callbacks.some(
      (callback) =>
        callback.id > beforeRestartCallback &&
        callback.job === "memory-compactor:pump" &&
        JSON.parse(callback.token).token === originalPumpToken
    ),
    "cold alarm retains the original scheduler identity"
  )
  await request("/wake?name=uncertain")
  await sleep(500)
  assert.equal((await request("/inspect?name=uncertain")).calls.length, 1)
  await request("/retry?name=uncertain&operation=retry-uncertain-one")
  const explicit = await until(
    "uncertain",
    (state) => state.nodes.length === 1,
    "explicit retry completes"
  )
  assert.equal(explicit.calls.length, 2)
  assert.notEqual(explicit.calls[1].claim.token, originalClaim.token)
  assert.deepEqual(
    explicit.routes.map((route) => route.requests),
    [1, 1]
  )
  await request("/retry?name=uncertain&operation=retry-uncertain-one")
  assert.equal(
    (await request("/inspect?name=uncertain")).calls.length,
    2,
    "exact retry replay cannot reset request authority"
  )
  assert.equal((await request("/stale?name=uncertain")).rejected, true)

  await request("/admit?name=budget&mode=oversize")
  const budget = await until(
    "budget",
    (state) => state.controls[0]?.control.state === "paused",
    "three actual retry rounds must exhaust",
    30_000
  )
  assert.equal(budget.controls[0].control.attempts, 3)
  assert.equal(budget.controls[0].control.pauseReason, "failed")
  assert.equal(budget.calls.length, 15)
  assert.equal(budget.routes[0].requests, 15)
  assert.equal(new Set(budget.calls.map((call) => call.claim.token)).size, 3)
  await request("/wake?name=budget")
  await sleep(500)
  assert.equal((await request("/inspect?name=budget")).calls.length, 15)
  await request("/retry?name=budget&operation=retry-budget-one")
  const freshBudget = await until(
    "budget",
    (state) => state.nodes.length === 1,
    "explicit retry owns new route budget"
  )
  assert.deepEqual(
    freshBudget.routes.map((route) => route.requests),
    [15, 1]
  )

  await request("/admit?name=publication&mode=publication")
  const exhausted = await until(
    "publication",
    (state) =>
      state.recovery !== null &&
      !state.jobs.some((job) => job.id === "memory-compactor:pump"),
    "failed exact publication exhausts cleanup and deletes its SDK pump row"
  )
  assert.equal(exhausted.calls.length, 1)
  assert.equal(exhausted.metrics.steps, 1)
  assert.equal(exhausted.metrics.settlements, 2)
  assert.deepEqual(pumpAttempts(exhausted).slice(-3), [1, 2, 3])
  assert.equal(exhausted.controls[0].control.state, "claimed")
  assert.equal(exhausted.controls[0].control.requestInFlight, false)
  await request("/wake?name=publication")
  assert.equal((await request("/inspect?name=publication")).calls.length, 1)
  await request("/recover?name=publication")
  const published = await until(
    "publication",
    (state) => state.nodes.length === 1,
    "explicit scheduler recovery publishes retained joined receipt"
  )
  assert.equal(
    published.calls.length,
    1,
    "publication recovery cannot call the model again"
  )
  assert.deepEqual(
    published.routes.map((route) => route.requests),
    [1]
  )

  await request("/admit?name=preclaim&mode=preclaim")
  const scanFailure = await until(
    "preclaim",
    (state) => state.recovery !== null,
    "preclaim storage failure retains bounded controller diagnostic"
  )
  assert.equal(scanFailure.calls.length, 0)
  assert.equal(scanFailure.metrics.steps, 1)
  assert.equal(scanFailure.metrics.settlements, 2)
  assert.deepEqual(pumpAttempts(scanFailure).slice(-3), [1, 2, 3])
  assert.equal(scanFailure.controls[0].control.state, "queued")
  assert.equal(
    scanFailure.controls[0].control.attempts,
    0,
    "unattributed scheduler failure cannot spend or pause a summary"
  )
  for (let n = 0; n < 3; n++) await request("/wake?name=preclaim")
  assert.deepEqual(
    (await request("/inspect?name=preclaim")).controls,
    scanFailure.controls
  )
  await request("/admit?name=cleanup&mode=cleanup")
  await until(
    "cleanup",
    (state) => state.calls.length === 1,
    "held cleanup native start"
  )
  await request("/dispose?name=cleanup")
  const held = await until(
    "cleanup",
    (state) => state.metrics.aborted === 1,
    "dispose must abort native request"
  )
  assert.equal(held.disposed, false)
  assert.equal(
    held.controls[0].control.state,
    "claimed",
    "native ownership survives cancellation until joined"
  )
  await request("/release?name=cleanup")
  const joined = await until(
    "cleanup",
    (state) => state.disposed,
    "native cleanup must join"
  )
  assert.equal(joined.metrics.joined, 1)
  assert.equal(joined.controls[0].control.state, "paused")
  assert.match(joined.disposalCause, /synthetic native cleanup defect/)
  assert.equal(joined.nodes.length, 0)

  await stop()
  await start()
  await sleep(500)
  const retainedFailure = await request("/inspect?name=preclaim")
  assert.equal(
    retainedFailure.recovery.epoch,
    scanFailure.recovery.epoch,
    "exhausted controller marker survives restart"
  )
  assert.equal(retainedFailure.metrics.steps, 1)
  assert.equal(
    retainedFailure.metrics.settlements,
    2,
    "restart cannot grant a fourth callback after durable exhaustion"
  )
  assert.equal(retainedFailure.calls.length, 0)
  assert.deepEqual(pumpAttempts(retainedFailure), pumpAttempts(scanFailure))
  await request("/wake?name=preclaim")
  assert.equal((await request("/inspect?name=preclaim")).metrics.steps, 1)
  await request("/recover?name=preclaim&mode=uncertain")
  const freshController = await until(
    "preclaim",
    (state) => state.calls.length === 1,
    "explicit controller recovery admits queued summary"
  )
  const freshToken = freshController.jobs.find(
    (job) => job.id === "memory-compactor:pump"
  ).payload.token
  const staleDelivery = await request("/stale-callback?name=preclaim")
  assert.equal(
    staleDelivery.calls.length,
    1,
    "retired controller callback cannot dispatch a second native request"
  )
  assert.equal(
    staleDelivery.jobs.find((job) => job.id === "memory-compactor:pump").payload
      .token,
    freshToken
  )
  await request("/release?name=preclaim")
  await until(
    "preclaim",
    (state) => state.nodes.length === 1,
    "fresh controller retains its native owner after stale delivery"
  )
  await stop()
  await start()
  for (const name of [
    "queued",
    "uncertain",
    "budget",
    "publication",
    "preclaim",
  ]) {
    const state = await request(`/inspect?name=${name}`)
    assert.equal(
      state.nodes.length,
      1,
      `${name}: second restart retains completed result`
    )
    assert.equal(
      state.calls.length,
      { queued: 1, uncertain: 2, budget: 16, publication: 1, preclaim: 1 }[name]
    )
  }
  console.log(
    JSON.stringify({
      workerd: workerd.compatibilityDate,
      queued: {
        calls: recovered.calls.length,
        alarmDriven: recovered.metrics.alarms > 0,
      },
      uncertain: {
        originalClaim: {
          start: originalClaim.start,
          count: originalClaim.count,
          token: originalClaim.token,
          revision: originalClaim.revision,
        },
        callsBeforeRetry: paused.calls.length,
        callsAfterRetry: explicit.calls.length,
      },
      budget: {
        attempts: budget.controls[0].control.attempts,
        requests: budget.routes[0].requests,
        retriedRequests: freshBudget.routes.map((route) => route.requests),
      },
      publication: {
        calls: published.calls.length,
        steps: exhausted.metrics.steps,
        settlements: exhausted.metrics.settlements,
        failedSdkAttempts: pumpAttempts(exhausted).slice(-3),
      },
      cleanup: {
        joined: joined.metrics.joined,
        paused: joined.controls[0].control.state,
        causeRetained: /synthetic native cleanup defect/.test(
          joined.disposalCause
        ),
      },
    })
  )
  console.log(
    "PASS B13 native retained alarm, SIGKILL uncertainty, exact explicit retry, bounded request budget, joined receipt cleanup and second restart"
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
