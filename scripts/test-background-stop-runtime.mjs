import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild")
const workerd = requireRuntime("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-background-stop-"))
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
const origin = `http://127.0.0.1:${port}`
let child,
  output = ""
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const stop = async () => {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise((done) => child.once("exit", done))
  child.kill("SIGKILL")
  await stopped
}
const start = async () => {
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
  for (let n = 0; n < 80; n++) {
    if (child.exitCode !== null) throw new Error(output)
    try {
      if ((await fetch(`${origin}/health`)).ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error(`workerd did not start: ${output}`)
}
const request = async (path) => {
  const response = await fetch(`${origin}${path}`)
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
try {
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/background-stop-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    logLevel: "error",
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
      bindings = [(name = "PROBES", durableObjectNamespace = (className = "BackgroundStopProbe"))],
      durableObjectNamespaces = [(className = "BackgroundStopProbe", uniqueKey = "background-stop-reference", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const seeded = await request("/seed?name=outage")
  assert.equal(seeded.row.stop_state, "pending")
  assert.equal(seeded.calls, 1)
  assert(seeded.job, "Stop recovery wake persists before shutdown")
  const identity = seeded.row.handoff
  const early = await request("/early?name=early")
  assert(early.job)
  let observed
  for (let index = 0; index < 50; index++) {
    observed = await request("/inspect?name=early")
    if (observed.steps > 0) break
    await sleep(20)
  }
  assert(observed.steps > 0, "real alarm scanned an empty mailbox")
  assert(observed.job, "early empty scan retains the admission lease")
  await request("/commit?name=early")
  await stop()
  await start()
  await sleep(5000)
  for (const name of ["outage", "early"]) {
    const restored = await request(`/inspect?name=${name}`)
    assert.equal(
      restored.row.stop_state,
      "confirmed",
      `${name}: actual alarm must retry Stop after SIGKILL without another object request`
    )
    assert.equal(restored.row.status, "cancelled")
    assert.equal(restored.calls, 2)
    assert.equal(restored.row.stop_attempts, 2)
    if (name === "outage") assert.deepEqual(restored.row.handoff, identity)
  }
  await request("/old-error?name=stale")
  for (let index = 0; index < 50; index++) {
    observed = await request("/inspect?name=stale")
    if (observed.exhausted) break
    await sleep(20)
  }
  assert(observed.exhausted)
  const replacement = await request("/replace?name=stale")
  await sleep(50)
  const fenced = await request("/inspect?name=stale")
  assert.equal(
    fenced.row.status,
    "pending",
    "old exhausted callback cannot pause a new admission"
  )
  assert.equal(fenced.row.error, null)
  assert.equal(fenced.job.payload.token, replacement.job.payload.token)
  await stop()
  await start()
  const retained = await request("/inspect?name=outage")
  assert.equal(retained.row.stop_state, "confirmed")
  assert.equal(retained.calls, 2)
  console.log(
    "PASS native background Stop: bounded outage recovery, early empty lease, SIGKILL alarm recovery, stale exhaustion fence and exact identities across two restarts"
  )
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
