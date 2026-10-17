import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild"),
  workerd = requireAlchemy("workerd")
const directory = await mkdtemp(join(tmpdir(), "pi-whatsapp-runtime-"))
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
let child,
  output = ""
async function start() {
  child = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
  )
  child.stdout.on("data", (data) => {
    output += data
  })
  child.stderr.on("data", (data) => {
    output += data
  })
  for (let i = 0; i < 100; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) return response.json()
      throw new Error(await response.text())
    } catch (error) {
      if (child.exitCode !== null || i === 99)
        throw new Error(`${String(error)}\n${output}`)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
}
async function stop() {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((done) => child.once("exit", done))
  child.kill("SIGTERM")
  await exited
}
try {
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/whatsapp-state-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    keepNames: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    alias: {
      "cloudflare:email": resolve("tests/runtime/unused-cloudflare-email.ts"),
    },
    logLevel: "error",
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
 services = [(name="fixture",worker=(
  compatibilityDate=${JSON.stringify(workerd.compatibilityDate)},compatibilityFlags=["nodejs_compat"],
  modules=[(name="worker.mjs",esModule=embed "worker.mjs")],
  bindings=[(name="PROBES",durableObjectNamespace=(className="WhatsAppStateProbe"))],
  durableObjectNamespaces=[(className="WhatsAppStateProbe",uniqueKey="whatsapp-state-probe",enableSql=true)],
  durableObjectStorage=(localDisk="storage")
 )),(name="storage",disk=(path="storage",writable=true))],
 sockets=[(name="http",address="127.0.0.1:${port}",http=(),service="fixture")]
);`
  )
  const first = await start()
  assert.equal(first.counter, 1)
  assert.equal(first.locked, true)
  assert.equal(first.duplicate, false)
  assert.deepEqual(first.list, ["two", "three"])
  await stop()
  const restarted = await start()
  assert.equal(restarted.counter, 2)
  assert.deepEqual(restarted.list, ["two", "three"])
  console.log(
    "WhatsApp Chat SDK state: native SQLite facets, locking, list bounds and restart persistence passed."
  )
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
