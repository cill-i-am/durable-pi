import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild")
const workerd = requireRuntime("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-xstate-"))
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
    entryPoints: [resolve("tests/runtime/xstate-worker.ts")],
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
      bindings = [(name = "PROBES", durableObjectNamespace = (className = "XStateProbe"))],
      durableObjectNamespaces = [(className = "XStateProbe", uniqueKey = "xstate-reference", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const broken = process.argv.includes("--break-recovery")
  const committed = await request(
    `/admit?name=committed&mode=${broken ? "broken-wake" : "normal"}`
  )
  assert.equal(committed.record.state.value, "pending")
  assert.equal(committed.dispatches, 0, "intent committed before dispatch")
  if (!broken)
    assert(committed.wake !== null, "recovery wake must precede intent commit")
  const lost = await request("/admit?name=lost&mode=lost-ack")
  assert.equal(
    lost.record.receipt,
    null,
    "simulate missing application acknowledgement"
  )
  assert.equal(lost.dispatches, 1)
  await stop()
  await start()
  // No object request starts recovery. Only the independent health handler ran.
  await sleep(2500)
  for (const name of ["committed", "lost"]) {
    const recovered = await request(`/inspect?name=${name}`)
    assert.equal(
      recovered.record.state.value,
      "complete",
      `${name}: alarm must recover without a user request`
    )
    assert.equal(
      recovered.calls,
      1,
      `${name}: native submission replay must not generate a second reply`
    )
    assert(recovered.record.receipt > 0)
    assert.equal(Object.keys(recovered.record.events).length, 2)
    const replay = await request(`/admit?name=${name}`)
    assert.deepEqual(
      replay.record,
      recovered.record,
      "completed admission is idempotent"
    )
    const conflict = await fetch(
      `${origin}/admit?name=${name}&content=different`
    )
    assert.equal(
      conflict.status,
      500,
      "same identity with different content must be rejected"
    )
    console.log(
      JSON.stringify({
        name,
        state: recovered.record.state.value,
        calls: recovered.calls,
        dispatches: recovered.dispatches,
        receipt: recovered.record.receipt,
        wake: recovered.wake,
      })
    )
  }
  await stop()
  await start()
  const retained = await request("/inspect?name=lost")
  assert.equal(retained.record.state.value, "complete")
  assert.equal(retained.calls, 1)
  const version = JSON.parse(
    await readFile(requireRuntime.resolve("workerd/package.json"), "utf8")
  ).version
  console.log(
    `PASS XState/Effect native intent, lost acknowledgement, alarm recovery and two SIGKILL/restarts; workerd ${version}.`
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
