import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild")
const workerd = requireRuntime("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-routines-"))
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
  const built = await build({
    metafile: true,
    entryPoints: [resolve("tests/runtime/routines-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    alias: {
      "@alchemy.run/cloudflare/Workers": join(
        dirname(requireRuntime.resolve("alchemy")),
        "Cloudflare/Workers/DurableObjectState.js"
      ),
    },
    logLevel: "error",
  })
  const sourceHashes = Object.fromEntries(
    await Promise.all(
      Object.keys(built.metafile.inputs)
        .filter(
          (path) => !path.includes("node_modules") && !path.startsWith("<")
        )
        .sort()
        .map(async (path) => [
          path,
          createHash("sha256")
            .update(await readFile(resolve(path)))
            .digest("hex"),
        ])
    )
  )
  console.log(
    JSON.stringify({
      case: "bundled-source-evidence",
      bundle: createHash("sha256")
        .update(await readFile(join(directory, "worker.mjs")))
        .digest("hex"),
      sourceHashes,
    })
  )
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
      bindings = [(name = "PROBES", durableObjectNamespace = (className = "RoutinesProbe"))],
      durableObjectNamespaces = [(className = "RoutinesProbe", uniqueKey = "routines-probe", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const brokenWake = process.argv.includes("--break-wake")
  const authorityOnly = process.argv.includes("--authority-only")
  const originals = new Map()
  const recovered = new Map()
  if (!authorityOnly) {
    for (const name of ["webhook", "manual"]) {
      const armed = await request(`/arm-empty?name=${name}`)
      assert(armed.lease > Date.now())
      let empty
      for (let n = 0; n < 50; n++) {
        empty = await request(`/inspect?name=${name}`)
        if (
          empty.alarms > 0 &&
          empty.wake === empty.lease &&
          empty.jobs.some(
            (job) => job.id === "routines:discovery" && job.time === empty.lease
          )
        )
          break
        await sleep(100)
      }
      assert(empty.alarms > 0, "real alarm must scan before acceptance")
      assert(
        empty.jobs.some(
          (job) => job.id === "routines:discovery" && job.time === empty.lease
        ),
        "empty scan must retain the original discovery lease"
      )
      assert.equal(
        empty.wake,
        empty.lease,
        "retained job owns the physical alarm"
      )
      assert.equal(empty.runs.length, 0)
      assert.equal(empty.calls, 0)
      const committed = await request(
        `/commit?name=${name}&kind=${name}${brokenWake ? "&break-wake" : ""}`
      )
      assert.equal(committed.runs.length, 1)
      assert.equal(committed.runs[0].status, "pending")
      assert.equal(
        committed.turns.length,
        0,
        "intent commits before Conversation admission"
      )
      assert.equal(committed.calls, 0)
      assert.equal(committed.lostWakes, 1)
      if (!brokenWake)
        assert(
          committed.wake !== null,
          "lost postcommit doorbell retains prearmed discovery"
        )
      else
        assert.equal(
          committed.wake,
          null,
          "negative control removes physical alarm only"
        )
      if (name === "webhook") {
        assert.equal(committed.events.length, 1)
        assert.equal(committed.events[0].event_id, "native-event-1")
        assert.equal(committed.events[0].run_id, committed.runs[0].id)
      }
      originals.set(name, committed)
    }
    await stop()
    await start()
    // Health requests do not address a Durable Object. No reconnect, manual
    // alarm or object request starts recovery during this production lease.
    const deadline = Math.max(
      ...[...originals.values()].map((value) => value.lease)
    )
    console.log(
      JSON.stringify({
        case: "waiting-for-retained-alarm",
        brokenWake,
        deadline,
        objectRequestsDuringRecovery: 0,
      })
    )
    await sleep(Math.max(0, deadline - Date.now()) + 8000)
    for (const name of ["webhook", "manual"]) {
      const state = await request(`/inspect?name=${name}`)
      const original = originals.get(name)
      assert.equal(
        state.runs[0].status,
        "done",
        `${name}: alarm must recover without any object request`
      )
      assert.equal(state.runs[0].id, original.runs[0].id)
      assert.equal(state.runs[0].turnId, original.runs[0].turnId)
      assert.equal(state.turns.length, 1)
      assert.equal(state.turns[0].id, original.runs[0].turnId)
      assert.equal(state.turns[0].status, "done")
      assert.equal(
        state.calls,
        1,
        "one synthetic generation for the original admitted turn"
      )
      assert.equal(state.submits, 1)
      assert.equal(state.admissions, 1)
      assert(state.boots >= 2)
      assert.deepEqual(state.events, original.events)
      const native = await request(`/native?name=${name}`)
      assert.equal(native.result.requestId, original.runs[0].turnId)
      assert.equal(native.result.status, "done")
      const replay = await request(`/replay?name=${name}&kind=${name}`)
      assert.deepEqual(replay.runs, state.runs)
      assert.equal(replay.turns.length, 1)
      assert.equal(replay.calls, 1)
      if (name === "webhook") {
        assert.equal(replay.result.duplicate, true)
        assert.equal(replay.result.runId, original.runs[0].id)
        const conflict = await request(`/conflict?name=${name}`)
        assert.equal(conflict.result._tag, "Failure")
        assert.equal(conflict.result.failure.reason, "conflict")
        assert.deepEqual(conflict.events, original.events)
        assert.equal(conflict.calls, 1)
      }
      recovered.set(name, { ...state, native: native.result })
      console.log(
        JSON.stringify({
          case: "retained-native-restart",
          name,
          run: state.runs[0].id,
          turn: state.turns[0].id,
          receipt: native.result.id,
          calls: state.calls,
          alarms: state.alarms,
          boots: state.boots,
        })
      )
    }
  }

  // Real domain authority and Conversation admission, with native dispatch held
  // before the first submit. This does not claim an in-flight provider abort.
  const pending = await request("/pause-pending?name=pause-pending")
  assert.equal(pending.runs[0].status, "cancelled")
  assert.equal(pending.turns.length, 0)
  assert.equal(pending.calls, 0)
  const admitted = await request("/pause-admitted?name=pause-admitted")
  assert.equal(admitted.runs[0].status, "queued")
  assert.equal(admitted.turns.length, 1)
  assert.equal(admitted.routines[0].status, "paused")
  assert.equal(
    admitted.result.canRun,
    true,
    "Pause preserves authority of an already admitted run"
  )
  assert.equal(admitted.calls, 0)
  const stopped = await request("/stop?name=pause-admitted")
  assert.equal(
    stopped.result.canRun,
    false,
    "Stop revokes admitted run authority before native dispatch"
  )
  let settled
  for (let n = 0; n < 80; n++) {
    settled = await request("/inspect?name=pause-admitted")
    if (settled.runs[0].status === "cancelled") break
    await sleep(100)
  }
  assert.equal(settled.runs[0].status, "cancelled")
  assert.equal(settled.turns[0].status, "cancelled")
  assert.equal(settled.calls, 0)
  assert.equal(settled.submits, 0)
  console.log(
    JSON.stringify({
      case: "pause-and-stop-before-native-dispatch",
      pending: pending.runs[0].status,
      admitted: admitted.runs[0].status,
      stopped: settled.runs[0].status,
      calls: settled.calls,
    })
  )

  if (!authorityOnly) {
    await stop()
    await start()
    for (const [name, before] of recovered) {
      const retained = await request(`/inspect?name=${name}`)
      assert.deepEqual(retained.runs, before.runs)
      assert.deepEqual(retained.events, before.events)
      assert.deepEqual(retained.turns, before.turns)
      assert.equal(retained.calls, before.calls)
      assert.equal(retained.submits, before.submits)
      assert.equal(retained.admissions, before.admissions)
      const native = await request(`/native?name=${name}`)
      assert.equal(native.result.id, before.native.id)
    }
  }
  const version = JSON.parse(
    await readFile(requireRuntime.resolve("workerd/package.json"), "utf8")
  ).version
  console.log(
    `PASS B11 actual RoutineRunner/Routines/Webhooks/Conversation/SQLite/Pi ${authorityOnly ? "Pause/Stop authority" : "retained discovery, original run/event/turn and native receipt identities, dedupe, Pause/Stop and two SIGKILL/restarts"}; workerd ${version}. Synthetic authority/provider; no live external execution or full PersonalAgent authorization claim.`
  )
} catch (error) {
  console.error(output)
  throw error
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
