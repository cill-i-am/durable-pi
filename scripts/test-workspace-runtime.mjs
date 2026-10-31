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
const directory = await mkdtemp(join(tmpdir(), "pi-workspace-native-"))
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
const origin = `http://127.0.0.1:${port}`
let child,
  output = ""
const evidence = {
  syntheticExtractors: true,
  bucket:
    "separate durable SQLite DO behind production r2WorkspaceAssets; not hosted R2",
  negative,
  snapshots: {},
  noPoke: undefined,
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const text = "Native Workspace extraction: exact 🍀 bytes."
const video = {
  duration: 1,
  frames: [{ at: 0, jpeg: "/9j/" }],
  captions: "Native Workspace video captions.",
  captionsTruncated: false,
}
const source = (kind) =>
  kind === "document"
    ? Buffer.from("%PDF-1.7 synthetic native document")
    : Buffer.from([0, 0, 0, 24, 102, 116, 121, 112])
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex")
const count = (value, event) =>
  value.events.filter((item) => item.value === event).length
const preparation = (value, kind = "document") =>
  (kind === "document" ? value.documents : value.videos)[0]
const id = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`
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
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] }
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
async function call(name, action, body = {}) {
  const response = await fetch(`${origin}/${name}/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw new Error(
      `${name}/${action}: ${response.status} ${await response.text()}\n${output.slice(-10000)}`
    )
  return response.json()
}
const snapshot = (name) => call(name, "status")
async function wait(name, predicate) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const value = await snapshot(name)
    if (predicate(value)) return value
    await sleep(20)
  }
  throw new Error(
    `Barrier missing: ${JSON.stringify(await snapshot(name))}\n${output.slice(-10000)}`
  )
}
function assertReady(value, before, kind, attempts = 1) {
  const row = preparation(value, kind),
    fileId = before.files[0].id
  assert.equal(
    row.status,
    "ready",
    "accepted preparation remained undiscovered after retained wake and SIGKILL"
  )
  assert.equal(row.id, fileId)
  assert.equal(row.attempts, attempts)
  assert.ok(
    row.attempt_id,
    "completed preparation retains its original attempt receipt"
  )
  assert.deepEqual(value.files, before.files)
  const bytes = Buffer.from(kind === "document" ? text : JSON.stringify(video))
  assert.equal(row.artifact_hash, sha(bytes))
  assert.deepEqual(
    value.assets,
    [
      {
        key: `synthetic-workspace/${fileId}/${sha(source(kind))}`,
        bytes: [...source(kind)],
        puts: 1,
      },
      {
        key: `synthetic-workspace/${fileId}/${sha(bytes)}/${kind === "document" ? "pdf-text-v1" : "video-v1"}`,
        bytes: [...bytes],
        puts: 1,
      },
    ].sort((a, b) => a.key.localeCompare(b.key))
  )
  assert.equal(count(value, `${kind}-extract`), attempts)
  assert.equal(count(value, "body-acquired"), attempts)
  assert.equal(count(value, "body-cancelled"), attempts)
}
async function resourceOwner() {
  const name = "held-resource"
  await call(name, "upload", { id: id(3), kind: "document" })
  await call(name, "fault", { name: "hold-artifact-put", value: 1 })
  await call(name, "pass")
  const entered = await wait(name, (value) => value.held)
  assert.equal(preparation(entered).status, "running")
  assert.equal(preparation(entered).attempts, 1)
  assert.ok(preparation(entered).attempt_id)
  await call(name, "warm-pass")
  await call(name, "interrupt")
  await sleep(50)
  const held = await snapshot(name)
  assert.deepEqual(held.documents, entered.documents)
  assert.equal(count(held, "document-extract"), 1)
  assert.equal(count(held, "pass-settled"), 0)
  assert.equal(held.assets.length, 1)
  const joined = await call(name, "release")
  evidence.snapshots.resourceOwner = { entered, held, joined }
  assert.equal(joined.held, false)
  assert.equal(count(joined, "pass-settled"), 2)
  assert.equal(count(joined, "document-extract"), 1)
  assert.equal(count(joined, "body-acquired"), 1)
  assert.equal(count(joined, "body-cancelled"), 1)
  assert.equal(joined.assets.length, 2)
  assert.equal(preparation(joined).status, "running")
  assert.equal(preparation(joined).attempt_id, preparation(entered).attempt_id)
  console.log(
    "PASS warm native resource ownership: interrupted artifact put joins before either caller settles; a fresh Workspace facade cannot steal the attempt. This held operation is released before process death."
  )
}
async function exhaustion() {
  const name = "exhaustion"
  const before = await call(name, "upload", { id: id(4), kind: "document" })
  await call(name, "fault", { name: "fail-extraction", value: 1 })
  await call(name, "automatic")
  const failed = await wait(
    name,
    (value) => preparation(value).status === "failed"
  )
  evidence.snapshots.exhaustion = { before, failed }
  assert.equal(preparation(failed).attempts, 3)
  assert.match(preparation(failed).error, /Retry from Files/)
  assert.equal(count(failed, "document-extract"), 3)
  assert.equal(count(failed, "body-acquired"), 3)
  assert.equal(count(failed, "body-cancelled"), 3)
  assert.deepEqual(failed.assets, before.assets)
  await call(name, "wake")
  const afterWake = await call(name, "dispatch")
  assert.equal(preparation(afterWake).attempts, 3)
  assert.equal(count(afterWake, "document-extract"), 3)
  console.log(
    "PASS native bounded preparation failure: exactly three extraction attempts leave an actionable Retry from Files state; another wake does not renew the business budget."
  )
  return { before, failed }
}
try {
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/workspace-worker.ts")],
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
            name: "break-workspace-retention-only",
            setup(builder) {
              builder.onLoad(
                { filter: /workspace\/discovery\.machine\.ts$/ },
                async ({ path }) => {
                  const content = await readFile(path, "utf8"),
                    needle = "if (context.armedUntil > event.now)"
                  assert.equal(content.split(needle).length, 2)
                  return {
                    contents: content.replace(needle, "if (false)"),
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
   bindings = [(name = "WORKSPACES", durableObjectNamespace = (className = "WorkspaceProbe")), (name = "ASSETS", durableObjectNamespace = (className = "WorkspaceAssetBucket"))],
   durableObjectNamespaces = [(className = "WorkspaceProbe", uniqueKey = "workspace-native", enableSql = true), (className = "WorkspaceAssetBucket", uniqueKey = "workspace-assets-native", enableSql = true)],
   durableObjectStorage = (localDisk = "storage"), globalOutbound = "blocked"
  )),
  (name = "blocked", worker = (compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, modules = [(name = "blocked.mjs", esModule = "export default {fetch(){return new Response('External calls disabled',{status:503})}};")])),
  (name = "storage", disk = (path = "storage", writable = true))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  let exhausted
  if (!negative) {
    await resourceOwner()
    exhausted = await exhaustion()
  }
  const admissions = []
  for (const [kind, number] of negative
    ? [["document", 1]]
    : [
        ["document", 1],
        ["video", 2],
      ]) {
    const name = `early-${kind}`
    const before = await call(name, "upload-lost-wake", {
      id: id(number),
      kind,
    })
    admissions.push({ name, kind, before })
    evidence.snapshots[`${name}BeforeRestart`] = before
    assert.equal(preparation(before, kind).status, "pending")
    assert.equal(preparation(before, kind).attempts, 0)
    assert.equal(count(before, `${kind}-extract`), 0)
    assert.equal(count(before, "empty-scan"), 2)
    assert.equal(before.assets.length, 1)
    if (!negative) {
      assert.equal(
        before.jobs.length,
        1,
        "unrelated alarm must not mask discovery"
      )
      assert.equal(before.jobs[0].id, "workspace-extraction:recovery")
      assert.equal(before.jobs[0].fn, "recover")
      assert.equal(before.jobs[0].payload.schemaVersion, 1)
      assert.equal(before.jobs[0].payload.workflowVersion, 1)
      assert.equal(before.jobs[0].payload.armedUntil, before.discoveryDeadline)
      assert.ok(before.jobs[0].payload.token)
      assert.equal(before.jobs[0].time, before.discoveryDeadline)
      assert.equal(before.physicalAlarm, before.discoveryDeadline)
      assert.ok(before.discoveryDeadline - before.now > 55000)
    }
  }
  if (!negative) {
    const name = "historical-pump"
    await call(name, "upload", { id: id(5), kind: "document" })
    const before = await call(name, "seed-historical")
    evidence.snapshots[`${name}BeforeRestart`] = before
    assert.equal(before.jobs.length, 1)
    assert.equal(before.jobs[0].id, "workspace-extraction:pump")
    assert.equal(before.jobs[0].capability, "workspace-extraction")
    assert.equal(before.jobs[0].fn, "pump")
    assert.equal(before.jobs[0].payload, undefined)
    assert.equal(before.jobs[0].retry, undefined)
    assert.equal(before.physicalAlarm, before.jobs[0].time)
    assert.equal(preparation(before).attempts, 0)
    assert.equal(count(before, "document-extract"), 0)
    admissions.push({ name, kind: "document", before })
  }
  await stop()
  const noPokeStart = Date.now()
  await start()
  const until =
    Math.max(...admissions.map(({ before }) => before.discoveryDeadline)) +
    10000
  console.log(
    "WAIT actual sixty-second retained Workspace discovery after SIGKILL; health-only startup and no object requests during recovery."
  )
  // The two empty-scan DOs each retain their own discovery lease; the
  // historical pump is isolated in a third DO. Synthetic extraction is immediate.
  // Ten seconds beyond the discovery deadline permits
  // the retained alarm plus the ordinary Lifecycle pump dispatch. No polling,
  // status read, restore call or unrelated job supplies recovery during this wait.
  while (Date.now() < until) await sleep(Math.min(30000, until - Date.now()))
  evidence.noPoke = {
    start: noPokeStart,
    end: Date.now(),
    discoveryDeadlines: admissions.map(
      ({ before }) => before.discoveryDeadline
    ),
  }
  const retained = []
  for (const { name, kind, before } of admissions) {
    const after = await snapshot(name)
    evidence.snapshots[`${name}AfterRestart`] = after
    assertReady(after, before, kind)
    assert.ok(count(after, "automatic") > 0)
    if (name === "historical-pump") {
      assert.deepEqual(
        after.events
          .filter((event) => event.value === "job-dispatch")
          .map((event) => JSON.parse(event.detail)),
        [{ id: "workspace-extraction:pump", payload: null }]
      )
      console.log(
        "PASS historical payloadless workspace-extraction:pump row: native restart consumes exactly that existing queue identity once, with no replacement job or renewed business attempt."
      )
    }
    assert.equal(after.jobs.length, 0)
    assert.equal(after.physicalAlarm, null)
    const served = await call(name, "read", { id: before.files[0].id, kind })
    evidence.snapshots[`${name}Served`] = served
    if (kind === "document") assert.equal(served.content.text, text)
    else assert.deepEqual(served.content, video)
    retained.push({ name, value: served })
  }
  if (negative) throw new Error("Broken discovery unexpectedly passed")
  console.log(
    "PASS real retained discovery: PDF and video intents survive pre-admission empty scans, lost post-commit wakes and SIGKILL; original file IDs and source bytes lead to exactly one content-addressed artifact and one business attempt each."
  )
  const stillFailed = await snapshot("exhaustion")
  assert.deepEqual(stillFailed.documents, exhausted.failed.documents)
  assert.equal(count(stillFailed, "document-extract"), 3)
  await call("exhaustion", "fault", { name: "fail-extraction", value: 0 })
  await call("exhaustion", "retry", { id: id(4) })
  const retried = await wait(
    "exhaustion",
    (value) => preparation(value).status === "ready"
  )
  evidence.snapshots.exhaustion = {
    ...evidence.snapshots.exhaustion,
    stillFailed,
    retried,
  }
  assert.equal(preparation(retried).attempts, 1)
  assert.equal(count(retried, "document-extract"), 4)
  assert.equal(count(retried, "body-acquired"), 4)
  assert.equal(count(retried, "body-cancelled"), 4)
  assert.notEqual(
    preparation(retried).attempt_id,
    preparation(stillFailed).attempt_id
  )
  assert.deepEqual(
    retried.assets.find((asset) => asset.key.endsWith("pdf-text-v1"))?.bytes,
    [...Buffer.from(text)]
  )
  assert.deepEqual(retried.files, exhausted.before.files)
  assert.equal(preparation(retried).artifact_hash, sha(Buffer.from(text)))
  retained.push({ name: "exhaustion", value: retried })
  await stop()
  await start()
  for (const { name, value } of retained) {
    const second = await snapshot(name)
    evidence.snapshots[`${name}SecondRestart`] = second
    assert.deepEqual(second.files, value.files)
    assert.deepEqual(second.documents, value.documents)
    assert.deepEqual(second.videos, value.videos)
    assert.deepEqual(second.assets, value.assets)
    assert.equal(
      count(second, "document-extract"),
      count(value, "document-extract")
    )
    assert.equal(count(second, "video-extract"), count(value, "video-extract"))
  }
  console.log(
    "PASS explicit retry alone renews exhausted budget; second SIGKILL retains exact completed metadata, source and artifact bytes without extraction replay. Production Workspace/SQLite/R2 adapter/Runner/Lifecycle; synthetic extractors and local durable bucket, no hosted R2 or live provider claim."
  )
} catch (error) {
  console.error(output.slice(-12000))
  throw error
} finally {
  const label = negative ? "negative" : "positive"
  await writeFile(
    join(tmpdir(), `durable-pi-workspace-native-${label}-evidence.json`),
    JSON.stringify(evidence, null, 2)
  )
  await writeFile(
    join(tmpdir(), `durable-pi-workspace-native-${label}-workerd.log`),
    output
  )
  await stop()
  await rm(directory, { recursive: true, force: true })
}
