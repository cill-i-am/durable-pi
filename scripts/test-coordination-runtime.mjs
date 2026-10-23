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
const directory = await mkdtemp(join(tmpdir(), "durable-pi-coordination-"))
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
    entryPoints: [resolve("tests/runtime/coordination-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    alias: {
      "alchemy/Cloudflare/Workers": join(
        dirname(requireAlchemy.resolve("alchemy")),
        "Cloudflare/Workers/DurableObjectState.js"
      ),
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
  services = [
    (name = "fixture", worker = (
      compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat", "enable_request_signal"],
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      bindings = [(name = "PROBES", durableObjectNamespace = (className = "CoordinationProbe"))],
      durableObjectNamespaces = [(className = "CoordinationProbe", uniqueKey = "coordination-probe", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const brokenOwner = process.argv.includes("--break-owner")
  const heldOnly = process.argv.includes("--held-only") || brokenOwner
  let recovered
  if (!heldOnly) {
    const armed = await request("/arm-empty")
    assert(armed.lease > Date.now())
    let empty
    for (let n = 0; n < 40; n++) {
      empty = await request("/inspect")
      if (empty.steps > 0 && empty.job?.time === empty.lease) break
      await sleep(100)
    }
    assert(empty.steps > 0, "real alarm must scan before acceptance")
    assert.equal(
      empty.job.time,
      empty.lease,
      "empty scan must retain original discovery lease"
    )
    const committed = await request("/commit")
    assert.equal(committed.row.phase, "pending")
    assert.equal(committed.initial, undefined)
    assert.equal(committed.message, undefined)
    assert(
      committed.wake !== null,
      "lost postcommit wake retains prearmed discovery"
    )
    const original = {
      message: committed.row.id,
      child: committed.child,
      parent: committed.parent,
    }
    await stop()
    await start()
    // No Durable Object request, manual alarm, or reconnect starts recovery.
    // The real production 60-second retained lease controls this wait.
    await sleep(Math.max(0, committed.lease - Date.now()) + 2500)
    recovered = await request("/inspect")
    assert.equal(recovered.row.phase, "delivered")
    assert.equal(recovered.row.id, original.message)
    assert.equal(recovered.child, original.child)
    assert.equal(recovered.parent, original.parent)
    assert.equal(recovered.initial.requestId, `delegation:7:${original.child}`)
    assert.equal(recovered.message.requestId, original.message)
    assert.equal(recovered.initial.status, "done")
    assert.equal(recovered.message.status, "done")
    assert.equal(
      recovered.group.closed,
      false,
      "detached group remains open after its initial answer"
    )
    assert(
      recovered.restores >= 2,
      "fresh runner must restore before alarm dispatch"
    )
    console.log(
      JSON.stringify({
        case: "retained-native-restart",
        emptySteps: empty.steps,
        restores: recovered.restores,
        message: recovered.row.id,
        initial: recovered.initial.id,
        addressed: recovered.message.id,
        calls: recovered.calls,
      })
    )
  }

  const held = await request(
    `/held?name=held${brokenOwner ? "&bypass-owner" : ""}`
  )
  assert.equal(
    held.message,
    undefined,
    "no receipt exists before actual native submission"
  )
  assert(held.trace.includes("submit-held"))
  const revoked = await request("/stop?name=held")
  assert.equal(
    revoked.group.children[0].stopped,
    true,
    "Stop revokes before joining dispatch"
  )
  assert.equal(
    revoked.stopped,
    0,
    "Stop has not acknowledged the held native dispatch"
  )
  assert.equal(revoked.message, undefined)
  assert(!revoked.trace.includes("abort-started"))
  const joined = await request("/release?name=held")
  const admission = joined.trace.indexOf(`admitted:${joined.row.id}`)
  const abort = joined.trace.indexOf("abort-started")
  const acknowledgement = joined.trace.indexOf("abort-acknowledged")
  const completed = joined.trace.indexOf("stop-returned")
  assert(
    admission >= 0 &&
      admission < abort &&
      abort < acknowledgement &&
      acknowledgement < completed,
    `Native admission must settle before abort and Stop acknowledgement: ${JSON.stringify(joined.trace)}`
  )
  assert.equal(joined.stopped, 1)
  assert.equal(
    joined.row.phase,
    "delivered",
    "delivered records acceptance, not an answer"
  )
  assert.equal(joined.group.children[0].lifecycle, "stopped")
  const control = await request("/stop-first?name=control")
  assert.equal(control.message, undefined)
  assert.equal(control.row.phase, "failed")
  assert(!control.trace.includes("submit-held"))
  console.log(
    JSON.stringify({
      case: "held-native-stop",
      trace: joined.trace,
      child: joined.child,
      message: joined.row.id,
      receipt: joined.message.id,
      stopFirstPhase: control.row.phase,
    })
  )

  if (!heldOnly) {
    await stop()
    await start()
    const retained = await request("/inspect")
    assert.equal(retained.initial.id, recovered.initial.id)
    assert.equal(retained.message.id, recovered.message.id)
    assert.equal(retained.calls, recovered.calls)
  }
  const version = JSON.parse(
    await readFile(requireAlchemy.resolve("workerd/package.json"), "utf8")
  ).version
  console.log(
    `PASS B08 actual Lifecycle/SQLite/Pi ${heldOnly ? "joined Stop and Stop-first control" : "retained discovery, original identities, joined Stop and two SIGKILL/restarts"}; workerd ${version}. Synthetic authority/provider; no full PersonalAgent authorization claim.`
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
