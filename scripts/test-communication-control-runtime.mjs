import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild"),
  workerd = requireAlchemy("workerd")
const negative = process.argv.includes("--negative-discovery")
const negativeRecovery = process.argv.includes("--negative-exhausted-epoch")
const recoveryOnly =
  process.argv.includes("--recovery-only") || negativeRecovery
const bundleOnly = process.argv.includes("--bundle-only")
const directory = await mkdtemp(join(tmpdir(), "pi-communication-control-"))
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
  negativeRecovery,
  recoveryOnly,
  instrumentation:
    "Production runner.onJobError is joined before a fixture barrier returns to the installed SDK applyOutcome; only the surviving row hung_timeout_seconds is shortened to1 for the crash revisit. No SDK lifecycle/queue replacement.",
  sourceHashes: {},
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
async function call(path, identity, body = {}) {
  const response = await fetch(`${origin}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ identity, ...body }),
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok)
    throw new Error(
      `${identity.owner}/${path}: ${response.status} ${await response.text()}\n${output.slice(-10000)}`
    )
  return response.json()
}
const control = (identity, action, body) =>
  call(`control/${action}`, identity, body)
const snapshot = (identity) => control(identity, "snapshot")
const count = (value, event) =>
  value.events.filter((item) => item.value === event).length
const task = (value, id) => value.tasks.find((row) => row.id === id)
const receipts = (value, id) =>
  value.native.filter((row) => row.requestId === `communication:${id}`)
async function wait(identity, predicate) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = await snapshot(identity)
    if (predicate(value)) return value
    await sleep(20)
  }
  throw new Error(
    `Barrier missing: ${JSON.stringify(await snapshot(identity))}\n${output.slice(-10000)}`
  )
}
async function setup(name) {
  const a = { owner: `communication-${name}`, bot: "home" }
  const b = { owner: a.owner, bot: "00000000-0000-4000-8000-000000000001" }
  await call("configure", a)
  await call("configure", b)
  await call("fault", b, { name: "native-pi", value: 1 })
  const envelope = {
    version: 1,
    id: name,
    taskId: name,
    owner: a.owner,
    from: a.bot,
    to: b.bot,
    correlationId: `turn:${name}`,
    causationId: `tool:${name}`,
    createdAt: Date.now(),
    deadline: Date.now() + 600000,
    depth: 1,
    payload: {
      kind: "question",
      objective: "What is 2 + 2?",
      context: "Synthetic native fixture only.",
    },
  }
  return { a, b, envelope, id: name }
}
async function seed(pair) {
  await control(pair.a, "hold-alarms")
  await control(pair.b, "hold-alarms")
  await call("enqueue", pair.a, { envelope: pair.envelope, unrelated: false })
  await control(pair.a, "pump")
  assert.equal(task(await snapshot(pair.b), pair.id).status, "accepted")
}
async function sendStop(pair) {
  await control(pair.a, "stop", { taskId: pair.id })
  await control(pair.a, "pump")
}
async function heldSubmit() {
  const pair = await setup("held-submit")
  await seed(pair)
  await call("fault", pair.b, { name: "hold-submit-ack", value: 1 })
  await control(pair.b, "pass")
  const entered = await wait(pair.b, (value) => value.held === "submit")
  assert.equal(receipts(entered, pair.id).length, 1)
  assert.equal(receipts(entered, pair.id)[0].status, "done")
  const owner = task(entered, pair.id).control.owner
  assert.ok(owner)
  console.log(
    "WAIT held native submit: cross the real thirty-second owner deadline before Stop and a replacement pass."
  )
  await sleep(
    Math.max(0, task(entered, pair.id).control.deadline + 100 - Date.now())
  )
  await sendStop(pair)
  await control(pair.b, "interrupt")
  await control(pair.b, "pass")
  await sleep(50)
  const held = await snapshot(pair.b)
  assert.equal(task(held, pair.id).control.owner, owner)
  assert.equal(task(held, pair.id).status, "cancelling")
  assert.equal(task(held, pair.id).stop.status, "pending")
  assert.equal(count(held, "submit"), 1)
  assert.equal(count(held, "abort-entered"), 0)
  assert.equal(count(held, "pass-settled"), 0)
  assert.equal(held.pins.length, 1)
  const denied = await control(pair.b, "permit-model", { taskId: pair.id })
  assert.equal(denied.permitted, false)
  assert.equal(count(denied, "pi-request"), 1)
  const joined = await control(pair.b, "release")
  evidence.snapshots[pair.id] = { entered, held, joined }
  assert.equal(task(joined, pair.id).status, "cancelling")
  assert.equal(task(joined, pair.id).control.owner, null)
  assert.equal(task(joined, pair.id).stop.status, "pending")
  assert.equal(count(joined, "abort-entered"), 0)
  assert.equal(joined.pins.length, 1)
  // The interrupted submit release retains Stop's finite retry time. Drive the
  // actual Lifecycle dispatch only after that persisted time, then assert the
  // exact outcome and command counts rather than polling until they look right.
  await sleep(Math.max(0, task(joined, pair.id).stop.nextAt + 20 - Date.now()))
  await control(pair.b, "wake")
  await control(pair.b, "dispatch")
  const released = await control(pair.b, "dispatch")
  evidence.snapshots[pair.id] = { entered, held, joined, released }
  assert.equal(
    task(released, pair.id).status,
    "cancelled",
    JSON.stringify(released)
  )
  assert.equal(task(released, pair.id).control.owner, null)
  assert.equal(task(released, pair.id).stop.status, "confirmed")
  assert.equal(count(released, "submit"), 1)
  assert.equal(count(released, "abort-entered"), 1)
  assert.equal(count(released, "abort-confirmed"), 1)
  assert.equal(count(released, "execution"), 1)
  assert.equal(released.pins.length, 0)
  assert.deepEqual(receipts(released, pair.id), receipts(entered, pair.id))
  evidence.snapshots.heldSubmit = { entered, held, denied, released }
  console.log(
    "PASS native held submit: real lease expiry cannot steal ownership; Stop revokes model authority, waits for joined handoff, then confirms one abort without another submission."
  )
}
async function heldAbort() {
  const pair = await setup("held-abort")
  await seed(pair)
  await call("fault", pair.b, { name: "hold-pi", value: 1 })
  await control(pair.b, "pump")
  await wait(pair.b, (value) => count(value, "pi-request") === 1)
  await call("fault", pair.b, { name: "hold-abort", value: 1 })
  await sendStop(pair)
  await control(pair.b, "pass")
  const entered = await wait(pair.b, (value) => value.held === "abort")
  const owner = task(entered, pair.id).control.owner
  await control(pair.b, "pass")
  await control(pair.b, "wake")
  await sleep(50)
  const held = await snapshot(pair.b)
  assert.equal(task(held, pair.id).control.owner, owner)
  assert.equal(task(held, pair.id).status, "cancelling")
  assert.equal(task(held, pair.id).stop.status, "pending")
  assert.equal(count(held, "abort-entered"), 1)
  assert.equal(count(held, "abort-confirmed"), 0)
  assert.equal(count(held, "pass-settled"), 0)
  assert.equal(held.pins.length, 1)
  const released = await control(pair.b, "release")
  evidence.snapshots[pair.id] = { entered, held, released }
  assert.equal(
    task(released, pair.id).status,
    "cancelled",
    JSON.stringify(released)
  )
  assert.equal(task(released, pair.id).control.owner, null)
  assert.equal(task(released, pair.id).stop.status, "confirmed")
  assert.equal(count(released, "submit"), 1)
  assert.equal(count(released, "abort-entered"), 1)
  assert.equal(count(released, "abort-confirmed"), 1)
  assert.equal(count(released, "execution"), 1)
  assert.equal(released.pins.length, 0)
  evidence.snapshots.heldAbort = { entered, held, released }
  console.log(
    "PASS native held abort: duplicate pass and wake retain one Stop owner until actual Pi abort joins."
  )
}
async function exhaustedEpochRecovery() {
  const identity = { owner: "communication-exhausted-epoch", bot: "home" }
  const pump = (value) =>
    value.sdkRows.find((row) => row.id === "bot-communication:pump")
  const marker = (value) => value.recoveryState?.recovery
  await call("configure", identity)
  await control(identity, "hold-alarms")
  await call("fault", identity, { name: "fail-unowned-pump", value: 1 })
  await call("fault", identity, { name: "hold-recovery-outcome", value: 1 })
  await control(identity, "wake")
  await control(identity, "recovery-dispatch")
  const first = await wait(
    identity,
    (value) => value.held === "recovery-outcome"
  )
  assert.equal(
    count(first, "unowned-pump-attempt"),
    3,
    "installed SDK must exhaust exactly three callbacks"
  )
  assert.ok(marker(first)?.epoch)
  assert.equal(marker(first).epoch, pump(first).payload.token)
  assert.equal(
    pump(first).running,
    1,
    "SDK applyOutcome must not have retired the original row"
  )
  assert.equal(first.tasks.length, 0)
  assert.equal(first.native.length, 0)
  const armed = await control(identity, "recovery-crash")
  assert.equal(pump(armed).running, 1)
  assert.deepEqual(pump(armed).payload, pump(first).payload)
  assert.equal(pump(armed).hung_timeout_seconds, 1)
  assert.ok(armed.physicalAlarm !== null)
  evidence.snapshots.exhaustedEpochBeforeCrash = { first, armed }
  await stop()
  const restart = Date.now()
  await start()
  // Health starts workerd without addressing this Durable Object. The retained
  // installed SDK alarm revisits its real surviving running row autonomously.
  await sleep(3000)
  const cold = await snapshot(identity)
  evidence.snapshots.exhaustedEpochAfterCrash = {
    noObjectRequestFrom: restart,
    observedAt: Date.now(),
    cold,
  }
  assert.ok(
    count(cold, "automatic") > count(first, "automatic"),
    "cold alarm must actually revisit the SDK row"
  )
  assert.equal(
    count(cold, "unowned-pump-attempt"),
    3,
    "an exhausted surviving epoch must never dispatch a fourth callback"
  )
  assert.deepEqual(marker(cold), marker(first))
  assert.equal(pump(cold), undefined)
  assert.equal(cold.physicalAlarm, null)
  const viewed = await control(identity, "recovery-read")
  assert.deepEqual(viewed.mailbox.recovery, marker(first))
  assert.equal(count(viewed, "unowned-pump-attempt"), 3)
  assert.equal(viewed.jobs.length, 0)

  await control(identity, "hold-alarms")
  const retried = await control(identity, "recovery-retry", {
    epoch: marker(first).epoch,
  })
  assert.equal(retried.accepted, true)
  assert.equal(marker(retried), null)
  const secondEpoch = pump(retried).payload.token
  assert.notEqual(secondEpoch, marker(first).epoch)
  await control(identity, "recovery-dispatch")
  const second = await wait(
    identity,
    (value) => value.held === "recovery-outcome"
  )
  assert.equal(count(second, "unowned-pump-attempt"), 6)
  assert.equal(marker(second).epoch, secondEpoch)
  assert.equal(pump(second).running, 1)
  // Explicit Retry while the failed SDK row still survives must retire exactly
  // that old epoch and mint a fresh budget before its old outcome is delivered.
  const fresh = await control(identity, "recovery-retry", {
    epoch: secondEpoch,
  })
  assert.equal(fresh.accepted, true)
  assert.equal(marker(fresh), null)
  assert.equal(fresh.recoveryState.retiredEpoch, secondEpoch)
  const thirdEpoch = pump(fresh).payload.token
  assert.notEqual(thirdEpoch, secondEpoch)
  assert.notEqual(thirdEpoch, marker(first).epoch)
  const released = await control(identity, "release")
  assert.equal(
    pump(released).payload.token,
    thirdEpoch,
    "old SDK outcome must preserve the replacement job"
  )
  await control(identity, "recovery-dispatch")
  const third = await wait(
    identity,
    (value) => value.held === "recovery-outcome"
  )
  assert.equal(count(third, "unowned-pump-attempt"), 9)
  assert.equal(marker(third).epoch, thirdEpoch)
  const stale = await control(identity, "recovery-retry", {
    epoch: secondEpoch,
  })
  assert.equal(stale.accepted, false)
  assert.ok(stale.failures.some((error) => error.code === "conflict"))
  assert.deepEqual(
    marker(stale),
    marker(third),
    "stale UI retry must not clear the newer failure"
  )
  assert.equal(pump(stale).payload.token, thirdEpoch)
  assert.equal(count(stale, "unowned-pump-attempt"), 9)
  evidence.snapshots.explicitEpochRecovery = {
    viewed,
    retried,
    second,
    fresh,
    released,
    third,
    stale,
  }
  await control(identity, "release")
  await stop()
  await start()
  const retained = await snapshot(identity)
  assert.deepEqual(marker(retained), marker(third))
  assert.equal(count(retained, "unowned-pump-attempt"), 9)
  assert.equal(retained.native.length, 0)
  assert.equal(retained.tasks.length, 0)
  evidence.snapshots.exhaustedEpochSecondRestart = retained
  console.log(
    "PASS actual Lifecycle exhausted-epoch crash window: exactly3 unowned callbacks, persisted summary plus surviving running row, cold autonomous alarm without a fourth dispatch; explicit Retry mints a new epoch even with an old SDK row, and stale UI retry cannot clear the next failure."
  )
}
try {
  await mkdir(join(directory, "storage"))
  for (const path of [
    "src/communication/adapters/lifecycle.ts",
    "src/communication/recovery.machine.ts",
    "tests/runtime/communication-control-worker.ts",
    "scripts/test-communication-control-runtime.mjs",
  ])
    evidence.sourceHashes[path] = createHash("sha256")
      .update(await readFile(resolve(path)))
      .digest("hex")
  await build({
    entryPoints: [resolve("tests/runtime/communication-control-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    keepNames: true,
    logLevel: "error",
    plugins:
      negative || negativeRecovery
        ? [
            {
              name: "break-communication-discovery-only",
              setup(builder) {
                if (negativeRecovery) {
                  builder.onLoad(
                    { filter: /communication\/adapters\/lifecycle\.ts$/ },
                    async ({ path }) => {
                      const source = await readFile(path, "utf8")
                      const needle =
                        "state.recovery?.epoch === owner.token ||\n      state.retiredEpoch === owner.token"
                      assert.equal(
                        source.split(needle).length,
                        2,
                        "exhausted-epoch negative boundary missing"
                      )
                      return {
                        contents: source.replace(needle, "false"),
                        loader: "ts",
                        resolveDir: dirname(path),
                      }
                    }
                  )
                  return
                }
                builder.onLoad(
                  { filter: /communication\/recovery\.machine\.ts$/ },
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
  if (bundleOnly) console.log("PASS communication control fixture bundle")
  else {
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
   bindings = [(name = "BOTS", durableObjectNamespace = (className = "MailboxBot"))],
   durableObjectNamespaces = [(className = "MailboxBot", uniqueKey = "communication-control-native", enableSql = true)],
   durableObjectStorage = (localDisk = "storage"), globalOutbound = "blocked"
  )),
  (name = "blocked", worker = (compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, modules = [(name = "blocked.mjs", esModule = "export default {fetch(){return new Response('External calls disabled',{status:503})}};")])),
  (name = "storage", disk = (path = "storage", writable = true))
 ], sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
    )
    await start()
    if (recoveryOnly) await exhaustedEpochRecovery()
    else {
      let lost
      if (!negative) {
        await exhaustedEpochRecovery()
        await heldSubmit()
        await heldAbort()
        lost = await setup("lost-native-ack")
        await seed(lost)
        await call("fault", lost.b, { name: "hold-submit-ack", value: 1 })
        await control(lost.b, "pass")
        const accepted = await wait(lost.b, (value) => value.held === "submit")
        assert.equal(count(accepted, "pi-request"), 1)
        assert.equal(receipts(accepted, lost.id).length, 1)
        assert.equal(receipts(accepted, lost.id)[0].status, "done")
        assert.equal(task(accepted, lost.id).status, "running")
        assert.ok(task(accepted, lost.id).control.owner)
        evidence.snapshots.lostAckBeforeRestart = accepted
      }
      const early = await setup("early-empty")
      const armed = await control(early.a, "arm-empty")
      if (!negative) {
        assert.equal(armed.tasks.length, 0)
        assert.equal(armed.jobs.length, 1, "an unrelated job masks discovery")
        assert.equal(armed.jobs[0].fn, "recover")
        assert.equal(armed.jobs[0].time, armed.deadline)
        assert.equal(armed.physicalAlarm, armed.deadline)
        assert.ok(armed.deadline - armed.now > 55000)
      }
      await sleep(40)
      const admitted = await control(early.a, "admit-lost-wake", {
        envelope: early.envelope,
      })
      assert.equal(task(admitted, early.id).status, "waiting")
      assert.equal(admitted.native.length, 0)
      assert.equal(admitted.deliveries[0].status, "pending")
      evidence.snapshots.earlyBeforeRestart = admitted
      if (lost) {
        const restart = await control(lost.b, "arm-restart")
        assert.ok(restart.physicalAlarm > Date.now())
        evidence.snapshots.lostAckBeforeRestartAlarm = restart
      }
      await stop()
      const noPokeStart = Date.now()
      await start()
      console.log(
        "WAIT native Communication SIGKILL recovery: health-only startup, no object request until the actual sixty-second discovery lease expires."
      )
      // Each wait remains below sixty seconds. No object fetch/RPC is made here.
      // This crash proof stops at sender discovery -> committed recipient receipt.
      // Receiver native execution has its own thirty-second observation lease and
      // is covered independently below and by the broad end-to-end runtime suite.
      // The lost-ack case already has a completed native result: its two-second
      // restoration alarm, result dispatch and sender's possible sixty-second empty
      // scan fit in this same seventy-five-second no-request interval.
      const until = admitted.deadline + 15000
      while (Date.now() < until)
        await sleep(Math.min(30000, until - Date.now()))
      evidence.noPoke = {
        start: noPokeStart,
        end: Date.now(),
        discoveryDeadline: admitted.deadline,
      }
      const recovered = await snapshot(early.a)
      const recipient = await snapshot(early.b)
      evidence.snapshots.earlyAfterRestart = { sender: recovered, recipient }
      const delivery = recovered.deliveries.find(
        (row) => row.envelope.id === early.id
      )
      assert.equal(
        delivery.status,
        "accepted",
        "accepted sender intent remained undelivered after retained discovery and SIGKILL"
      )
      assert.equal(delivery.attempts, 1)
      assert.deepEqual(delivery.envelope, early.envelope)
      assert.equal(delivery.receipt.id, early.id)
      assert.equal(delivery.receipt.taskId, early.id)
      assert.ok(delivery.receipt.acceptedAt >= admitted.deadline)
      assert.equal(recipient.tasks.length, 1)
      assert.deepEqual(task(recipient, early.id).request, early.envelope)
      assert.deepEqual(recipient.inbox, [
        {
          id: early.id,
          content: early.envelope,
          receipt: delivery.receipt,
        },
      ])
      assert.ok(count(recovered, "automatic") > 0)
      assert.equal(count(recovered, "unrelated"), 0)
      assert.equal(count(recipient, "unrelated"), 0)
      console.log(
        "PASS native admission no-request recovery: the real sixty-second retained discovery dispatches one original envelope and commits exactly one matching recipient inbox receipt."
      )
      if (lost) {
        const sender = await snapshot(lost.a),
          recipient = await snapshot(lost.b)
        evidence.snapshots.lostAckAfterRestart = { sender, recipient }
        assert.equal(task(sender, lost.id).status, "completed")
        assert.equal(task(sender, lost.id).resumed, true)
        assert.equal(task(sender, lost.id).outcome.text, "Native Pi result: 4")
        assert.equal(task(recipient, lost.id).status, "completed")
        assert.equal(count(sender, "continuation"), 1)
        assert.equal(count(recipient, "pi-request"), 1)
        assert.equal(count(recipient, "submit"), 1)
        assert.equal(task(recipient, lost.id).control.owner, null)
        assert.deepEqual(
          receipts(recipient, lost.id),
          receipts(evidence.snapshots.lostAckBeforeRestart, lost.id)
        )
        console.log(
          "PASS native result no-request recovery: accepted native result reconciles after lost acknowledgement with the same receipt, one continuation and no model call or resubmission."
        )
        await stop()
        await start()
        const retained = await snapshot(lost.a)
        assert.deepEqual(retained.tasks, sender.tasks)
        assert.deepEqual(retained.deliveries, sender.deliveries)
        assert.equal(count(retained, "continuation"), 1)
        console.log(
          "PASS second SIGKILL: exact completed task and delivery rows retained; continuation remains consumed once. All model responses are synthetic."
        )
      } else throw new Error("Broken discovery unexpectedly passed")
    }
  }
} catch (error) {
  console.error(output.slice(-12000))
  throw error
} finally {
  await writeFile(
    join(
      tmpdir(),
      `durable-pi-communication-native-${recoveryOnly ? (negativeRecovery ? "recovery-negative" : "recovery-positive") : negative ? "negative" : "evidence"}.json`
    ),
    JSON.stringify(evidence, null, 2)
  )
  await writeFile(
    join(
      tmpdir(),
      `durable-pi-communication-native-${recoveryOnly ? (negativeRecovery ? "recovery-negative" : "recovery-positive") : negative ? "negative" : "workerd"}.log`
    ),
    output
  )
  await stop()
  await rm(directory, { recursive: true, force: true })
}
