import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, resolve, join } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild")
const workerd = requireRuntime("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-memory-"))
await mkdir(join(directory, "storage"), { recursive: true })
await build({
  entryPoints: [resolve("tests/runtime/memory-latency-worker.ts")],
  outfile: join(directory, "worker.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["node:*", "cloudflare:*"],
  logLevel: "error",
})
const listener = createServer()
await new Promise((done) => listener.listen(0, "127.0.0.1", done))
const port = listener.address().port
await new Promise((done) => listener.close(done))
const schema = resolve(
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
   compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat"],
   modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
   bindings = [(name = "PROBES", durableObjectNamespace = (className = "MemoryLatencyProbe"))],
   durableObjectNamespaces = [(className = "MemoryLatencyProbe", uniqueKey = "memory-regressions", enableSql = true)],
   durableObjectStorage = (localDisk = "storage")
  )),
  (name = "storage", disk = (path = "storage", writable = true))
 ],
 sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
)
let child,
  logs = ""
const origin = `http://127.0.0.1:${port}`
async function start() {
  child = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
  )
  child.stdout.on("data", (chunk) => {
    logs += chunk
  })
  child.stderr.on("data", (chunk) => {
    logs += chunk
  })
  for (let n = 0; n < 80; n++) {
    if (child.exitCode !== null) throw new Error(logs)
    try {
      if ((await fetch(origin + "/health")).ok) return
    } catch {}
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error("Native fixture did not become ready: " + logs)
}
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const stopped = new Promise((done) => child.once("exit", done))
  child.kill("SIGKILL")
  await stopped
}
async function request(path, body) {
  const response = await fetch(
    origin + path,
    body
      ? {
          method: "POST",
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : undefined
  )
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}
try {
  await start()
  const growth = await request("/growth")
  assert.equal(growth.total, 300)
  assert(
    growth.parts < 251,
    "view must compact past the old 100-parameter failure"
  )
  assert.deepEqual(await request("/rollback"), {
    failed: true,
    rolledBack: true,
  })
  assert.deepEqual(await request("/restore"), {
    total: 300,
    parts: 300,
    ready: 300,
  })
  const pending = await request("/pending")
  assert.equal(pending.exact, true)
  assert.equal(pending.archiveExact, true)
  assert(pending.bytes < 8500)
  console.log(
    `PASS memory growth, multi-batch rollback, restore/bootstrap, and 123 MB Unicode/NUL backlog on workerd ${workerd.compatibilityDate}`
  )
} catch (error) {
  console.error(logs)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
