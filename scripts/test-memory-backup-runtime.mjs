import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild")
const workerd = requireRuntime("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-memory-backup-"))
const listener = createServer()
await new Promise((done) => listener.listen(0, "127.0.0.1", done))
const port = listener.address().port
await new Promise((done) => listener.close(done))
const origin = `http://127.0.0.1:${port}`
const broken = process.argv.includes("--negative-discovery")
const smoke = process.argv.includes("--smoke")
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const claims = (state) =>
  state.events
    .filter((e) => e.event === "claim")
    .map((e) => JSON.parse(e.detail))
const jobs = (state, id) =>
  state.events
    .filter((e) => e.event === "job")
    .map((e) => JSON.parse(e.detail))
    .filter((j) => j.id === id)
const object = (state, key) => state.objects.find((o) => o.key === `p/${key}`)
const complete = (state) =>
  state.control?.phase === "idle" &&
  JSON.parse(state.control.watermark).messages === 1
const evidence = { directory, broken, sources: {}, cases: {}, noPoke: [] }
let child,
  output = ""
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((done) => child.once("exit", done))
  child.kill("SIGKILL")
  await exited
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
  throw new Error(`Native backup fixture did not start: ${output}`)
}
async function request(name, action = "status", body = {}) {
  const response = await fetch(`${origin}/${name}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  assert.equal(response.status, 200, await response.clone().text())
  return response.json()
}
async function until(name, test, message, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let state
  while (Date.now() < deadline) {
    state = await request(name)
    if (test(state)) return state
    await sleep(100)
  }
  evidence.cases[`${name}-timeout`] = state
  assert.fail(`${message}: ${JSON.stringify(state)}`)
}
const fault = (name, faultName, value) =>
  request(name, "fault", { name: faultName, value })
async function retainFailure(name) {
  await fault(name, "fail-wake", 1)
  await request(name, "start-discovery")
  const failed = await until(
    name,
    (s) => s.diagnostic?.phase === "exhausted",
    "three SDK discovery attempts must persist recovery"
  )
  assert.deepEqual(
    jobs(failed, "memory-backups:discovery").map((j) => j.attempt),
    [1, 2, 3]
  )
  return failed
}
try {
  const paths = [
    "src/memory/backup.ts",
    "src/memory/backup.machine.ts",
    "src/memory/backup-publication.machine.ts",
    "src/memory/backup-dispatch.machine.ts",
    "src/memory/backup-discovery.machine.ts",
    "src/memory/adapters/backup-lifecycle.ts",
    "src/memory/adapters/backup-status.ts",
    "src/memory/backup-status.ts",
    "src/memory/application.ts",
    "tests/runtime/memory-backup-worker.ts",
    "scripts/test-memory-backup-runtime.mjs",
  ]
  for (const path of paths)
    evidence.sources[path] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex")
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/memory-backup-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    logLevel: "error",
    define: { NEGATIVE_DISCOVERY: String(broken) },
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
   bindings = [(name = "BACKUPS", durableObjectNamespace = (className = "MemoryBackupProbe")), (name = "BUCKETS", durableObjectNamespace = (className = "BackupBucketProbe"))],
   durableObjectNamespaces = [(className = "MemoryBackupProbe", uniqueKey = "memory-backup-b18", enableSql = true), (className = "BackupBucketProbe", uniqueKey = "memory-backup-b18-bucket", enableSql = true)],
   durableObjectStorage = (localDisk = "storage")
  )),
  (name = "storage", disk = (path = "storage", writable = true))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  if (smoke) {
    await request("smoke", "seed")
    await request("smoke", "start-backup")
    evidence.cases.smoke = await until(
      "smoke",
      complete,
      "real alarm must publish synthetic memory"
    )
    console.log("B18 native smoke passed")
  } else {
    if (!broken) {
      await request("live", "seed")
      await fault("live", "hold-latest", 1)
      await request("live", "start-backup")
      const live = await until(
        "live",
        (s) => s.held,
        "native publication must be held"
      )
      const exhausted = await retainFailure("live")
      const denied = await request("live", "probe-live-retry")
      assert.match(denied.domain, /still running/)
      assert.match(denied.scheduler, /still running/)
      assert.deepEqual(claims(denied), claims(live))
      assert.deepEqual(
        denied.jobs.find((j) => j.id === "memory-backups:pump").payload,
        live.jobs.find((j) => j.id === "memory-backups:pump").payload
      )
      await fault("live", "fail-wake", 0)
      await request("live", "release")
      assert.equal(
        (
          await request("live", "recover", {
            epoch: exhausted.diagnostic.recovery.epoch,
          })
        ).recovered,
        true
      )
      evidence.cases.live = await until(
        "live",
        (s) => complete(s) && !s.diagnostic?.claim,
        "recovery must settle exact joined owner"
      )
      assert.equal(claims(evidence.cases.live).length, 1)
      evidence.cases.schedulerBefore = await retainFailure("diagnostic")
      await request("budget", "seed")
      await fault("budget", "fail-reads", 1)
      await request("budget", "start-backup")
      evidence.cases.budgetBefore = await until(
        "budget",
        (s) => s.control?.phase === "failed",
        "business retry budget must exhaust after three failures",
        35_000
      )
      assert.deepEqual(
        claims(evidence.cases.budgetBefore).map((c) => c.attempts),
        [1, 2, 3]
      )
      await request("budget", "start-backup")
      await sleep(500)
      assert.equal(claims(await request("budget")).length, 3)
      await request("cas", "seed")
      await request("cas", "cas-first")
      await until("cas", (s) => s.held, "old latest CAS must be held")
      const newer = await request("cas", "cas-new")
      assert.equal(
        JSON.parse(object(newer, "latest.json").body).until.messages,
        2
      )
      const settled = await request("cas", "release")
      assert.equal(
        object(settled, "latest.json").body,
        object(newer, "latest.json").body
      )
      assert.equal(
        JSON.parse(
          settled.events.find((e) => e.event === "cas-old-exit").detail
        ).failed,
        true
      )
      evidence.cases.cas = await request("cas", "read")
      assert.equal(evidence.cases.cas.archive.until.messages, 2)
      await request("checkpoint", "seed")
      await fault("checkpoint", "hold-latest", 1)
      await request("checkpoint", "start-backup")
      evidence.cases.checkpointBefore = await until(
        "checkpoint",
        (s) => s.held,
        "checkpoint must commit before latest acknowledgement"
      )
      assert.equal(claims(evidence.cases.checkpointBefore).length, 1)
      assert.equal(
        object(evidence.cases.checkpointBefore, "latest.json"),
        undefined
      )
      assert.ok(object(evidence.cases.checkpointBefore, "progress.json"))
    }
    const admitted = await request("early", "lost-wake")
    evidence.cases.admitted = admitted
    assert.equal(admitted.memory.length, 1)
    assert.equal(admitted.control.phase, "idle")
    assert.equal(JSON.parse(admitted.control.watermark).messages, 0)
    assert.ok(admitted.events.find((e) => e.event === "empty-scan"))
    assert.ok(
      admitted.events.find((e) => e.event === "postcommit-wake-dropped")
    )
    if (!broken) {
      assert.deepEqual(
        admitted.jobs.map((j) => j.id),
        ["memory-backups:discovery"]
      )
      assert.equal(
        admitted.jobs[0].payload.deadline,
        admitted.discoveryDeadline
      )
      assert.equal(admitted.alarm, admitted.discoveryDeadline)
    } else assert.equal(admitted.jobs.length, 0)
    await stop()
    await start()
    // Only Worker /health was called. No DO request, status poll, or recovery command
    // occurs until the retained production sixty-second discovery lease has elapsed.
    const noPoke = {
      start: Date.now(),
      deadline: admitted.discoveryDeadline + 10_000,
    }
    console.log(
      `B18 no-object-request recovery until ${new Date(noPoke.deadline).toISOString()}`
    )
    while (Date.now() < noPoke.deadline)
      await sleep(Math.min(1000, noPoke.deadline - Date.now()))
    noPoke.end = Date.now()
    evidence.noPoke.push(noPoke)
    const recovered = await request("early")
    evidence.cases.recovered = recovered
    assert.equal(
      JSON.parse(recovered.control.watermark).messages,
      1,
      "retained empty-scan discovery must publish admitted memory after SIGKILL without a poke"
    )
    assert.equal(recovered.control.phase, "idle")
    assert.deepEqual(recovered.memory, admitted.memory)
    assert.equal(claims(recovered).length, 1)
    assert.equal(claims(recovered)[0].attempts, 1)
    assert.equal(JSON.parse(claims(recovered)[0].target).messages, 1)
    assert.ok(
      recovered.events.find((e) => e.event === "alarm" && e.at >= noPoke.start)
    )
    assert.equal(recovered.jobs.length, 0)
    if (!broken) {
      const checkpoint = await request("checkpoint")
      evidence.cases.checkpointAfter = checkpoint
      assert.ok(complete(checkpoint))
      assert.deepEqual(
        claims(checkpoint).map((c) => c.attempts),
        [1, 2]
      )
      assert.equal(claims(checkpoint)[0].target, claims(checkpoint)[1].target)
      assert.notEqual(
        claims(checkpoint)[0].attemptId,
        claims(checkpoint)[1].attemptId
      )
      assert.equal(
        object(checkpoint, "latest.json").body,
        object(evidence.cases.checkpointBefore, "progress.json").body
      )
      const batches = checkpoint.objects.filter((o) =>
        o.key.includes("/batches/")
      )
      assert.equal(batches.length, 1)
      assert.equal(batches[0].puts, 1)
      for (const saved of checkpoint.objects.filter((entry) =>
        /\/(batches|snapshots)\//.test(entry.key)
      ))
        assert.ok(
          saved.key.endsWith(
            `${createHash("sha256").update(saved.body).digest("hex")}.json`
          ),
          "immutable remote key retains exact content hash"
        )
      const budget = await request("budget")
      assert.equal(budget.control.phase, "failed")
      assert.equal(budget.control.attempts, 3)
      assert.equal(claims(budget).length, 3)
      await request("budget", "start-backup")
      await sleep(500)
      assert.equal(claims(await request("budget")).length, 3)
      await fault("budget", "fail-reads", 0)
      assert.equal(
        (
          await request("budget", "retry", {
            attemptId: budget.control.attempt_id,
            target: budget.control.target,
          })
        ).retried,
        true
      )
      evidence.cases.budgetAfter = await until(
        "budget",
        complete,
        "exact explicit retry must publish with a new attempt"
      )
      assert.deepEqual(
        claims(evidence.cases.budgetAfter).map((c) => c.attempts),
        [1, 2, 3, 1]
      )
      assert.notEqual(
        claims(evidence.cases.budgetAfter).at(-1).attemptId,
        budget.control.attempt_id
      )
      const diagnostic = await request("diagnostic")
      assert.deepEqual(
        diagnostic.diagnostic,
        evidence.cases.schedulerBefore.diagnostic
      )
      assert.equal(jobs(diagnostic, "memory-backups:discovery").length, 3)
      await fault("diagnostic", "fail-wake", 0)
      await request("diagnostic", "start-backup")
      await sleep(300)
      assert.equal(
        jobs(await request("diagnostic"), "memory-backups:discovery").length,
        3
      )
      assert.equal(
        (
          await request("diagnostic", "recover", {
            epoch: diagnostic.diagnostic.recovery.epoch,
          })
        ).recovered,
        true
      )
      evidence.cases.schedulerAfter = await until(
        "diagnostic",
        (s) =>
          s.diagnostic.phase === "available" &&
          s.control?.phase === "idle" &&
          s.control.watermark ===
            JSON.stringify({ messages: 0, nodes: 0, notes: 0 }) &&
          claims(s).length === 1 &&
          object(s, "latest.json") !== undefined,
        "exact scheduler recovery must publish through a new native claim"
      )
      const stable = Object.fromEntries(
        await Promise.all(
          ["early", "checkpoint", "budget", "cas"].map(async (name) => [
            name,
            await request(name),
          ])
        )
      )
      await stop()
      await start()
      for (const [name, before] of Object.entries(stable)) {
        const after = await request(name)
        assert.deepEqual(after.control, before.control)
        assert.deepEqual(after.memory, before.memory)
        assert.deepEqual(after.objects, before.objects)
        assert.deepEqual(claims(after), claims(before))
      }
      evidence.cases.secondRestart =
        "stable control, memory, remote immutable objects, and exact claims"
    }
    console.log(
      "B18 native backup retained discovery, retry budgets, CAS, checkpoint identity, and second restart passed"
    )
  }
} catch (error) {
  evidence.error = String(error)
  throw error
} finally {
  await stop()
  await writeFile(join(directory, "workerd.log"), output)
  await writeFile(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2)
  )
  console.log(`B18 native evidence: ${directory}`)
}
