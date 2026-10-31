import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireRuntime = createRequire(import.meta.url)
const { build } = requireRuntime("esbuild"),
  workerd = requireRuntime("workerd")
const negative = process.argv.includes("--negative-discovery")
const directory = await mkdtemp(join(tmpdir(), "pi-conversation-runtime-"))
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
const origin = `http://127.0.0.1:${port}`
let child,
  output = ""
const evidence = {
  syntheticProvider: true,
  negative,
  snapshots: {},
  noPoke: undefined,
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
async function dispatchDue(name) {
  // One alarm scans due rows once. Discovery may retime the pump beyond that
  // scan's cutoff, so explicitly drive the next warm alarm as well.
  await call(name, "dispatch")
  return call(name, "dispatch")
}
async function wait(name, predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await call(name, "status")
    if (predicate(value)) return value
    await sleep(20)
  }
  throw new Error(
    `Barrier not reached for ${name}: ${JSON.stringify(await call(name, "status"))}\n${output.slice(-10000)}`
  )
}
const root = (snapshot) =>
  snapshot.rows.find((row) => row.id === "synthetic-root")
const receipts = (snapshot) =>
  snapshot.native.filter((record) => record.requestId === "synthetic-root")
async function heldOwnership(mode) {
  const name = mode
  await call(name, "setup", { mode })
  await call(name, "start-pass")
  const entered = await wait(name, (value) => value.state.holdEntered)
  const owner = root(entered).control.owner
  assert.ok(owner)
  const continuation = await call(name, "new-root")
  if (mode === "held-submit") {
    assert.equal(continuation.rejected, undefined)
    assert.equal(
      continuation.rows.find((row) => row.id === "synthetic-next").parent_id,
      "synthetic-root"
    )
    await call(name, "stop")
  } else {
    assert.equal(continuation.rejected, true)
    await call(name, "interrupt")
  }
  const held = await call(name, "pump")
  assert.equal(
    root(held).control.owner,
    owner,
    "another control pass stole the held native owner"
  )
  assert.equal(held.metrics.submitCalls, 1)
  assert.equal(
    held.metrics.abortCalls,
    0,
    "held abort escaped before its owner joined"
  )
  assert.equal(held.state.settled, false)
  const joined = await call(name, "release")
  assert.equal(root(joined).control.owner, null)
  assert.equal(root(joined).status, "stopping")
  if (mode === "held-submit") {
    assert.equal(
      root(joined).control.attempts,
      0,
      "old handoff consumed the fresh Stop budget"
    )
    assert.equal(
      root(joined).control.unconfirmed,
      null,
      "old handoff made fresh Stop unconfirmed"
    )
    assert.match(
      joined.state.failure,
      /synthetic late handoff failure after fresh Stop/
    )
  }
  const stopped = await call(name, "pump")
  assert.equal(root(stopped).status, "cancelled")
  assert.equal(stopped.metrics.submitCalls, 1)
  assert.equal(stopped.metrics.abortCalls, 1)
  assert.equal(receipts(stopped).length, 1)
  assert.equal(
    (await call(name, "new-root", { id: "late-reuse" })).rejected,
    true
  )
  evidence.snapshots[name] = { entered, held, joined, stopped }
  console.log(
    `PASS native ${mode}: owner retained until joined cancellation; no overlapping native command or stopped-session reuse.`
  )
}
try {
  await mkdir(join(directory, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/conversation-control-worker.ts")],
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
            name: "break-conversation-discovery-only",
            setup(builder) {
              builder.onLoad(
                { filter: /conversations\/recovery-discovery\.machine\.ts$/ },
                async ({ path }) => {
                  const source = await readFile(path, "utf8"),
                    needle = "if (context.armedUntil > event.now)"
                  assert.equal(source.split(needle).length, 2)
                  return {
                    contents: source.replace(needle, "if (false)"),
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
   bindings = [(name = "CONVERSATIONS", durableObjectNamespace = (className = "ConversationControlProbe"))],
   durableObjectNamespaces = [(className = "ConversationControlProbe", uniqueKey = "conversation-control-native", enableSql = true)],
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
    await heldOwnership("held-submit")
    await heldOwnership("held-abort")
    await call("exhaustion", "setup", { mode: "exhaustion" })
    await call("exhaustion", "wake")
    const exhausted = await dispatchDue("exhaustion")
    evidence.snapshots.exhaustionBeforeRestart = exhausted
    assert.equal(exhausted.metrics.configureCalls, 3)
    assert.equal(root(exhausted).control.attempts, 3)
    assert.ok(
      root(exhausted).control.owner,
      "failed release must retain ownership"
    )
    assert.equal(exhausted.native.length, 0)
    for (let attempt = 0; attempt < 3; attempt++) {
      await call("exhaustion", "wake")
      const repeated = await dispatchDue("exhaustion")
      assert.equal(
        repeated.metrics.configureCalls,
        3,
        "new queue identity renewed exhausted domain budget"
      )
      assert.equal(root(repeated).control.owner, root(exhausted).control.owner)
    }
    evidence.snapshots.exhaustionBeforeRestart = exhausted
    await call("exhaustion", "heal")
    await call("lost-ack", "setup", { mode: "lost-ack" })
    await call("lost-ack", "start-pass")
    const accepted = await wait("lost-ack", (value) => value.state.holdEntered)
    assert.equal(root(accepted).status, "preparing")
    assert.equal(accepted.metrics.calls, 1)
    assert.equal(receipts(accepted).length, 1)
    assert.equal(receipts(accepted)[0].status, "done")
    evidence.snapshots.lostAckBeforeRestart = accepted
  }
  const armed = await call("early-empty", "arm")
  if (!negative) {
    const discovery = armed.jobs.find((job) => job.fn === "recover")
    assert.ok(discovery, "the empty scan consumed admission discovery")
    assert.equal(discovery.time, armed.deadline)
    assert.equal(armed.physicalAlarm, armed.deadline)
    assert.ok(
      armed.deadline - armed.now > 55000,
      "proof must use the real sixty-second discovery lease"
    )
  }
  await sleep(40)
  const acceptedEarly = await call("early-empty", "admit-lost-wake")
  assert.equal(root(acceptedEarly).status, "queued")
  assert.equal(acceptedEarly.native.length, 0)
  evidence.snapshots.earlyBeforeRestart = acceptedEarly
  if (!negative) {
    const lostRestart = await call("lost-ack", "arm-restart")
    const exhaustedRestart = await call("exhaustion", "arm-restart")
    const earlyRestart = await call("early-empty", "status")
    evidence.snapshots.beforeKillAlarms = {
      lostRestart,
      exhaustedRestart,
      earlyRestart,
    }
    assert.equal(earlyRestart.physicalAlarm, earlyRestart.deadline)
    assert.ok(earlyRestart.physicalAlarm > Date.now())
    assert.ok(lostRestart.physicalAlarm > Date.now())
    assert.ok(exhaustedRestart.physicalAlarm > Date.now())
  }
  // No request reaches any Durable Object after restart until this real lease
  // expires and alarm work has had time to finish. /health never opens an object.
  await stop()
  const noPokeStart = Date.now()
  await start()
  console.log(
    "WAIT native SIGKILL recovery: health-only startup; no Durable Object requests until the real discovery lease expires."
  )
  await sleep(Math.max(0, acceptedEarly.deadline + 8000 - Date.now()))
  evidence.noPoke = {
    start: noPokeStart,
    end: Date.now(),
    discoveryDeadline: acceptedEarly.deadline,
  }
  const early = await call("early-empty", "status")
  evidence.snapshots.earlyAfterRestart = early
  assert.equal(
    root(early).status,
    "done",
    "delayed accepted intent was stranded after early empty discovery and SIGKILL"
  )
  assert.equal(early.metrics.calls, 1)
  assert.ok(early.metrics.automatic > 0)
  assert.equal(receipts(early).length, 1)
  assert.equal(receipts(early)[0].status, "done")
  if (negative) {
    console.error("Broken discovery control unexpectedly passed")
  } else {
    const lost = await call("lost-ack", "status")
    evidence.snapshots.lostAckAfterRestart = lost
    assert.equal(root(lost).status, "done")
    assert.equal(lost.metrics.calls, 1)
    assert.equal(lost.metrics.submitCalls, 1)
    assert.deepEqual(
      receipts(lost),
      receipts(evidence.snapshots.lostAckBeforeRestart)
    )
    assert.equal(
      root(lost).session_id,
      root(evidence.snapshots.lostAckBeforeRestart).session_id
    )
    console.log(
      "PASS native no-poke recovery: early-empty sixty-second admission discovery and lost acknowledgement reconcile the same durable native request without another synthetic provider call."
    )
    const exhausted = await call("exhaustion", "status")
    evidence.snapshots.exhaustionAfterRestart = exhausted
    assert.equal(exhausted.metrics.configureCalls, 3)
    assert.equal(exhausted.native.length, 0)
    assert.equal(root(exhausted).control.owner, null)
    assert.ok(root(exhausted).control.unconfirmed)
    const checked = await call("exhaustion", "check", {
      revision: root(exhausted).revision,
    })
    assert.equal(
      checked.native.length,
      0,
      "Check authorized another native submission"
    )
    assert.equal(checked.metrics.configureCalls, 3)
    assert.ok(root(checked).control.unconfirmed)
    await call("exhaustion", "fail-stop")
    const uncertainStop = await dispatchDue("exhaustion")
    evidence.snapshots.explicitRecovery = { checked, uncertainStop }
    assert.equal(root(uncertainStop).status, "stopping")
    assert.equal(root(uncertainStop).control.unconfirmed, "stop")
    assert.equal(root(uncertainStop).control.attempts, 3)
    assert.equal(uncertainStop.metrics.abortCalls, 0)
    await call("exhaustion", "heal")
    const revision = root(uncertainStop).revision
    const stale = await call("exhaustion", "retry-stop", {
      revision: revision - 1,
    })
    assert.equal(stale.rejected, true)
    assert.equal(root(stale).revision, revision)
    const retried = await call("exhaustion", "retry-stop", { revision })
    evidence.snapshots.explicitRecovery = {
      checked,
      uncertainStop,
      stale,
      retried,
    }
    assert.equal(retried.rejected, undefined)
    const stopped = await dispatchDue("exhaustion")
    assert.equal(root(stopped).status, "cancelled")
    assert.equal(stopped.metrics.abortCalls, 1)
    assert.equal(stopped.metrics.configureCalls, 3)
    evidence.snapshots.explicitRecovery.stopped = stopped
    console.log(
      "PASS native exhausted-write outage: repeated wakes and cold restoration preserve the spent budget; Check observes only, and revisioned Retry Stop confirms cancellation."
    )
    const resumed = await call("early-empty", "new-root", {
      id: "legitimate-reuse",
    })
    const sameSession = resumed.rows.find(
      (row) => row.id === "legitimate-reuse"
    )
    assert.equal(sameSession.session_id, root(early).session_id)
    await call("early-empty", "pump")
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await call("early-empty", "pump")
      if (
        value.rows.find((row) => row.id === "legitimate-reuse")?.status ===
        "done"
      ) {
        evidence.snapshots.reusedSession = value
        break
      }
      await sleep(25)
    }
    assert.equal(
      evidence.snapshots.reusedSession?.rows.find(
        (row) => row.id === "legitimate-reuse"
      )?.status,
      "done"
    )
    assert.equal(evidence.snapshots.reusedSession.metrics.calls, 2)
    assert.equal(evidence.snapshots.reusedSession.metrics.abortCalls, 0)
    assert.equal(evidence.snapshots.reusedSession.native.length, 2)
    const reusedReceipt = evidence.snapshots.reusedSession.native.find(
      (record) => record.requestId === "legitimate-reuse"
    )
    assert.ok(reusedReceipt)
    assert.notEqual(reusedReceipt.id, receipts(early)[0].id)
    assert.equal(reusedReceipt.status, "done")
    console.log(
      "PASS native session reuse: a later addressed request uses the original Pi conversation and a distinct request receipt after prior ownership is released. All provider responses are synthetic."
    )
  }
} catch (error) {
  console.error(output.slice(-12000))
  throw error
} finally {
  try {
    await writeFile(
      join(
        tmpdir(),
        `durable-pi-conversation-native-${negative ? "negative" : "evidence"}.json`
      ),
      JSON.stringify(evidence, null, 2)
    )
  } finally {
    await stop()
    await rm(directory, { recursive: true, force: true })
  }
}
