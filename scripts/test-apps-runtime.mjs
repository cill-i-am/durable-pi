import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild"),
  workerd = requireRuntime("workerd")
const negative = process.argv.includes("--negative-discovery")
const directory = await mkdtemp(join(tmpdir(), "pi-apps-runtime-"))
const prefix =
  process.env.APPS_RUNTIME_EVIDENCE ??
  join(
    tmpdir(),
    `apps-native-${negative ? "negative" : "positive"}-${process.pid}`
  )
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
const origin = `http://127.0.0.1:${port}`
let child,
  output = "",
  objectRequests = 0
const evidence = {
  negative,
  syntheticAuthority: true,
  syntheticProvider: true,
  rendering:
    "Checklist interaction; remote renderer and live side effects are outside this proof.",
  source: {},
  snapshots: {},
  noPoke: [],
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const closed = new Promise((done) => child.once("exit", done))
  child.kill("SIGKILL")
  await closed
}
async function start() {
  child = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    {
      cwd: directory,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
  child.stdout.on("data", (data) => {
    output += data
  })
  child.stderr.on("data", (data) => {
    output += data
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return
    } catch {}
    if (child.exitCode !== null)
      throw new Error(`workerd exited: ${output.slice(-10000)}`)
    await sleep(50)
  }
  throw new Error(`workerd startup failed: ${output.slice(-10000)}`)
}
async function call(name, action) {
  objectRequests++
  const response = await fetch(`${origin}/${name}/${action}`, {
    method: "POST",
    headers: { connection: "close" },
    body: "{}",
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw new Error(
      `${name}/${action}: ${response.status} ${await response.text()}\n${output.slice(-10000)}`
    )
  return response.json()
}
const event = (value) => value.app.events[0]?.record
const nativeFor = (value, turnId) =>
  value.native.filter((record) => record.requestId === turnId)
try {
  for (const file of [
    "src/apps/adapters/lifecycle.ts",
    "src/apps/adapters/sqlite.ts",
    "src/apps/discovery.machine.ts",
    "src/apps/delivery.machine.ts",
    "src/apps/pump.ts",
    "src/apps/pump.machine.ts",
    "tests/runtime/apps-worker.ts",
    "tests/runtime/conversation-control-worker.ts",
    "scripts/test-apps-runtime.mjs",
  ])
    evidence.source[file] = createHash("sha256")
      .update(await readFile(file))
      .digest("hex")
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/apps-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    keepNames: true,
    logLevel: "error",
    plugins: negative
      ? [
          {
            name: "break-app-discovery-only",
            setup(builder) {
              builder.onLoad(
                { filter: /apps\/discovery\.machine\.ts$/ },
                async ({ path }) => {
                  const source = await readFile(path, "utf8")
                  const needle =
                    "context.armedUntil > event.now ? context.armedUntil : Infinity"
                  assert.equal(
                    source.split(needle).length,
                    2,
                    "negative control must disable only armed empty-scan retention"
                  )
                  return {
                    contents: source.replace(needle, "Infinity"),
                    loader: "ts",
                    resolveDir: dirname(path),
                  }
                }
              )
            },
          },
        ]
      : [],
  })
  const schema = join(
    dirname(requireRuntime.resolve("workerd")),
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
   bindings = [(name = "APPS", durableObjectNamespace = (className = "AppsProbe"))],
   durableObjectNamespaces = [(className = "AppsProbe", uniqueKey = "apps-native", enableSql = true)],
   durableObjectStorage = (localDisk = "storage"), globalOutbound = "blocked"
  )),
  (name = "blocked", worker = (compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, modules = [(name = "blocked.mjs", esModule = "export default {fetch(){return new Response('External calls disabled',{status:503})}};" )])),
  (name = "storage", disk = (path = "storage", writable = true))
 ],
 sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  if (!negative) {
    await call("exhaustion", "arm-empty")
    await call("exhaustion", "commit-lost-wake")
    const exhausted = await call("exhaustion", "exhaust")
    evidence.snapshots.exhausted = exhausted
    assert.equal(
      exhausted.app.passes,
      4,
      "one empty pass plus exactly three failed SDK attempts"
    )
    assert.equal(event(exhausted).delivery, "exhausted")
    assert.equal(exhausted.app.admissions, 0)
    assert.equal(exhausted.rows.length, 0)
    assert.equal(exhausted.app.jobs[0].payload.state, "exhausted")
    for (let attempt = 0; attempt < 2; attempt++) {
      const repeated = await call("exhaustion", "wake")
      assert.equal(
        repeated.app.passes,
        4,
        "ordinary wake renewed spent Apps execution budget"
      )
    }
  }
  const armed = await call("early-empty", "arm-empty")
  evidence.snapshots.armed = armed
  assert.equal(armed.app.passes, 1)
  assert.equal(armed.app.events.length, 0)
  assert.equal(armed.rows.length, 0)
  assert.ok(
    armed.app.deadline - armed.now > 55000,
    "use the actual sixty-second admission lease"
  )
  if (!negative) {
    assert.equal(armed.app.jobs.length, 1)
    assert.equal(armed.app.jobs[0].id, "app-events:pump")
    assert.equal(armed.app.jobs[0].time, armed.app.deadline)
    assert.equal(armed.physicalAlarm, armed.app.deadline)
  }
  const committed = await call("early-empty", "commit-lost-wake")
  evidence.snapshots.committed = committed
  assert.equal(event(committed).delivery, "pending")
  assert.equal(committed.app.receipts.length, 1)
  assert.equal(committed.app.events.length, 1)
  assert.equal(committed.app.admissions, 0)
  assert.equal(committed.rows.length, 0)
  assert.equal(committed.native.length, 0)
  const accepted = event(committed)
  await stop()
  const beforeRequests = objectRequests,
    began = Date.now()
  await start()
  console.log(
    "WAIT Apps SIGKILL recovery: health-only startup, no object requests until real discovery deadline plus native completion margin."
  )
  await sleep(Math.max(0, committed.app.deadline + 12000 - Date.now()))
  evidence.noPoke.push({
    began,
    ended: Date.now(),
    objectRequests: objectRequests - beforeRequests,
    deadline: committed.app.deadline,
  })
  assert.equal(objectRequests, beforeRequests)
  const recovered = await call("early-empty", "status")
  evidence.snapshots.recovered = recovered
  assert.equal(
    event(recovered).delivery,
    "queued",
    "accepted App interaction stranded after empty scan, lost wake and SIGKILL"
  )
  assert.equal(event(recovered).id, accepted.id)
  assert.equal(event(recovered).turnId, accepted.turnId)
  assert.equal(recovered.app.events.length, 1)
  assert.equal(recovered.app.receipts.length, 1)
  assert.equal(recovered.app.admissions, 1)
  assert.equal(recovered.rows.length, 1)
  assert.equal(recovered.rows[0].id, accepted.turnId)
  assert.equal(recovered.rows[0].status, "done")
  assert.equal(recovered.metrics.calls, 1)
  assert.equal(recovered.metrics.submitCalls, 1)
  assert.equal(nativeFor(recovered, accepted.turnId).length, 1)
  assert.equal(nativeFor(recovered, accepted.turnId)[0].status, "done")
  assert.ok(recovered.metrics.automatic > 0)
  if (negative) throw new Error("Broken discovery unexpectedly passed")
  const exhaustedRestart = await call("exhaustion", "status")
  evidence.snapshots.exhaustedRestart = exhaustedRestart
  assert.equal(exhaustedRestart.app.passes, 4)
  assert.equal(event(exhaustedRestart).delivery, "exhausted")
  assert.equal(exhaustedRestart.app.admissions, 0)
  await stop()
  const secondRequests = objectRequests,
    secondBegan = Date.now()
  await start()
  await sleep(1500)
  evidence.noPoke.push({
    began: secondBegan,
    ended: Date.now(),
    objectRequests: objectRequests - secondRequests,
  })
  const retained = await call("early-empty", "status")
  evidence.snapshots.secondRestart = retained
  assert.equal(retained.app.admissions, 1)
  assert.equal(retained.metrics.calls, 1)
  assert.deepEqual(retained.app.events, recovered.app.events)
  assert.deepEqual(retained.app.receipts, recovered.app.receipts)
  assert.deepEqual(
    nativeFor(retained, accepted.turnId),
    nativeFor(recovered, accepted.turnId)
  )
  const replayed = await call("early-empty", "replay")
  evidence.snapshots.exactReplay = replayed
  assert.equal(replayed.app.events.length, 1)
  assert.equal(replayed.app.receipts.length, 1)
  assert.equal(replayed.app.admissions, 1)
  assert.equal(replayed.metrics.calls, 1)
  console.log(
    "PASS native Apps: retained empty discovery, real shared admission and Pi receipt after no-poke SIGKILL, bounded SDK exhaustion, second restart and exact receipt replay."
  )
} catch (error) {
  evidence.failure = String(error)
  throw error
} finally {
  await stop()
  await writeFile(`${prefix}-evidence.json`, JSON.stringify(evidence, null, 2))
  await writeFile(`${prefix}-workerd.log`, output)
  console.log(`Apps native evidence: ${prefix}-evidence.json`)
  await rm(directory, { recursive: true, force: true })
}
