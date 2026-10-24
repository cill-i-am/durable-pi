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
async function start(probe = true) {
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
      const response = await fetch(
        `http://127.0.0.1:${port}/${probe ? "" : "health"}`
      )
      if (response.ok) return response.json()
      throw new Error(await response.text())
    } catch (error) {
      if (child.exitCode !== null || i === 99)
        throw new Error(`${String(error)}\n${output}`)
      await new Promise((done) => setTimeout(done, 50))
    }
  }
}
async function stop(signal = "SIGTERM") {
  if (!child || child.exitCode !== null) return
  const exited = new Promise((done) => child.once("exit", done))
  child.kill(signal)
  await exited
}
async function waitForBarrier(call, channel, name, field) {
  for (let attempt = 0; ; attempt++) {
    if ((await call(channel, name, "status"))[field]) return
    assert.ok(attempt < 100, `${name} ${field} barrier was not reached`)
    await new Promise((done) => setTimeout(done, 10))
  }
}
async function prepareOutages(call, channel, retain) {
  await call(channel, "all-sql", "setup")
  await call(channel, "all-sql", "lost-wake")
  await call(channel, "all-sql", "fault-all-sql")
  retain(channel, "all-sql")
  const unavailable = await call(channel, "all-sql", "exercise-all-sql")
  assert.equal(unavailable.failures.length, 2)
  assert.ok(
    unavailable.failures.every((failure) =>
      failure.includes("fixture all SQLite unavailable")
    )
  )
  assert.ok(unavailable.faults >= 2)
  for (const name of ["outage-read", "outage-new", "outage-restart"]) {
    await call(channel, name, "setup")
    retain(channel, name)
    await call(channel, name, "lost-wake")
    await call(channel, name, "fault-terminal")
    await call(channel, name, "wake")
    const failed = await call(channel, name, "dispatch")
    assert.equal(failed.row.state, "queued")
    assert.equal(failed.metrics.sends, 0)
  }
  for (const [name, fault] of [
    ["outage-send", "fault-checkpoint"],
    ["outage-complete", "fault-finish"],
  ]) {
    await call(channel, name, "setup")
    retain(channel, name)
    await call(channel, name, "lost-wake")
    await call(channel, name, fault)
    await call(channel, name, "wake")
    await call(channel, name, "dispatch")
    await call(channel, name, "pump-due")
    const held = await call(channel, name, "dispatch")
    assert.equal(held.row.state, "sending")
    assert.equal(held.metrics.sends, 1)
    assert.deepEqual(
      held.row.delivery.receipts,
      name === "outage-complete" ? ["provider-confirmed"] : []
    )
  }
  for (const replacePump of [false, true]) {
    const name = `exhaust-race-${replacePump}`
    await call(channel, name, "setup")
    await call(channel, name, "lost-wake")
    await call(channel, name, "fault-pump")
    await call(channel, name, "wake")
    await call(channel, name, "hold-exhaust")
    const dispatch = call(channel, name, "dispatch")
    await waitForBarrier(call, channel, name, "exhaustReady")
    const admitted = await call(channel, name, "admit-other")
    if (replacePump) await call(channel, name, "wake")
    await call(channel, name, "release-exhaust")
    const result = await dispatch
    assert.equal(
      result.other.state,
      "queued",
      "old terminal callback consumed newer admission"
    )
    assert.equal(result.row.state, "queued")
    assert.equal(result.metrics.sends, 0)
    assert.deepEqual(
      result.jobs.find((job) => job.fn === "recover").payload,
      admitted.jobs.find((job) => job.fn === "recover").payload
    )
  }
}
async function withOutageInstances(call, work) {
  let active = true,
    failure
  const retained = new Map()
  const retain = (channel, name) => {
    retained.set(`${channel}/${name}`, { channel, name })
  }
  const pulse = (async () => {
    while (active) {
      await Promise.all(
        [...retained.values()].map(async ({ channel, name }) => {
          const current = await call(channel, name, "keep-alive")
          if (name === "all-sql")
            assert.equal(
              current.sqlUnavailable,
              true,
              `${channel}/${name}: SQL fault fixture was evicted`
            )
        })
      )
      await new Promise((done) => setTimeout(done, 1000))
    }
  })().catch((error) => {
    failure = error
    active = false
  })
  let result
  try {
    result = await work(retain)
  } finally {
    active = false
    await pulse
  }
  if (failure) throw failure
  return result
}
async function exhaustOutage(call, channel, name) {
  await call(channel, name, "due")
  await call(channel, name, "pump-due")
  await call(channel, name, "dispatch")
  const exhausted = await call(channel, name, "dispatch")
  assert.deepEqual(
    exhausted.jobs,
    [],
    `${name}: finite queue budget did not exhaust`
  )
  await call(channel, name, "heal-outage")
  return exhausted
}
async function finishOutages(call, channel) {
  const restoredSql = await call(channel, "all-sql", "heal-all-sql")
  assert.equal(restoredSql.row.state, "queued")
  assert.equal(restoredSql.metrics.work, 0)
  assert.equal(restoredSql.metrics.sends, 0)
  assert.ok(
    restoredSql.jobs.some((job) => job.fn === "recover"),
    "whole SQL outage lost its prearmed job"
  )
  const rearmed = await call(channel, "all-sql", "reconcile")
  assert.deepEqual(
    rearmed.jobs,
    restoredSql.jobs,
    "rearming changed durable queue intent"
  )
  await call(channel, "all-sql", "hold-scan")
  const dispatch = call(channel, "all-sql", "dispatch")
  await waitForBarrier(call, channel, "all-sql", "scanned")
  await call(channel, "all-sql", "release")
  const bounded = await dispatch
  assert.equal(bounded.row.state, "failed")
  assert.equal(bounded.metrics.work, 0)
  assert.equal(bounded.metrics.sends, 0)
  assert.deepEqual(bounded.jobs, [], "expired recovery kept shifting its pump")
  const read = await exhaustOutage(call, channel, "outage-read")
  assert.equal(read.row.state, "queued")
  const repaired = await call(channel, "outage-read", "reconcile")
  assert.equal(repaired.row.state, "failed")
  assert.equal(repaired.row.id, read.row.id)
  assert.equal(repaired.metrics.sends, 0)
  await call(channel, "outage-read", "retry")
  await call(channel, "outage-read", "dispatch")
  await call(channel, "outage-read", "pump-due")
  const retried = await call(channel, "outage-read", "dispatch")
  assert.equal(retried.row.state, "sent")
  assert.equal(retried.row.id, read.row.id)
  assert.equal(retried.metrics.sends, 1)

  const old = await exhaustOutage(call, channel, "outage-new")
  await call(channel, "outage-new", "admit-other")
  await call(channel, "outage-new", "wake")
  await call(channel, "outage-new", "dispatch")
  await call(channel, "outage-new", "pump-due")
  const next = await call(channel, "outage-new", "dispatch")
  assert.equal(next.row.state, "failed", "new inbound resurrected expired work")
  assert.equal(next.other.state, "sent")
  assert.equal(
    next.metrics.work,
    old.metrics.work + 1,
    "old native preparation ran again"
  )
  assert.equal(next.metrics.sends, 1)

  for (const [name, state] of [
    ["outage-send", "uncertain"],
    ["outage-complete", "sent"],
  ]) {
    const previous = await exhaustOutage(call, channel, name)
    assert.equal(previous.row.state, "sending")
    const current = await call(channel, name, "reconcile")
    assert.equal(current.row.state, state)
    assert.deepEqual(current.row.delivery, previous.row.delivery)
    assert.equal(
      current.metrics.sends,
      1,
      "orphan reconciliation sent another provider part"
    )
  }
  return exhaustOutage(call, channel, "outage-restart")
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
  bindings=[(name="PROBES",durableObjectNamespace=(className="WhatsAppStateProbe")),(name="EMAIL_RECOVERY",durableObjectNamespace=(className="EmailRecoveryProbe")),(name="WHATSAPP_RECOVERY",durableObjectNamespace=(className="WhatsAppRecoveryProbe"))],
  durableObjectNamespaces=[(className="WhatsAppStateProbe",uniqueKey="whatsapp-state-probe",enableSql=true),(className="EmailRecoveryProbe",uniqueKey="email-recovery-probe",enableSql=true),(className="WhatsAppRecoveryProbe",uniqueKey="whatsapp-recovery-probe",enableSql=true)],
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
  for (const reply of first.replies) {
    assert.equal(reply.state, "uncertain")
    assert.equal(reply.receipts.length, 1)
    assert.deepEqual(reply.sends, ["confirmed first", "unconfirmed second"])
  }
  assert.equal(first.attachments.pending, true)
  assert.equal(first.attachments.jobPending, true)
  assert.equal(first.attachments.input, "[]")
  await stop("SIGKILL")
  const restarted = await start()
  assert.equal(restarted.attachments.id, first.attachments.id)
  assert.equal(restarted.attachments.pending, false)
  assert.equal(restarted.attachments.files, 1)
  assert.equal(restarted.attachments.jobPending, false)
  assert.ok(
    restarted.attachments.input.includes("NATIVE_PREPARATION_RESTART_OK")
  )
  assert.equal(restarted.counter, 2)
  assert.deepEqual(restarted.list, ["two", "three"])
  for (const reply of restarted.replies) {
    assert.equal(reply.state, "uncertain")
    assert.equal(reply.receipts.length, 1)
    assert.deepEqual(reply.sends, ["confirmed first", "unconfirmed second"])
  }
  const retried = await (await fetch(`http://127.0.0.1:${port}/`)).json()
  for (const reply of retried.replies) {
    assert.equal(reply.state, "sent")
    assert.equal(reply.receipts.length, 2)
    assert.deepEqual(reply.sends, [
      "confirmed first",
      "unconfirmed second",
      "unconfirmed second",
    ])
  }
  const call = async (channel, name, action, query = "") => {
    const response = await fetch(
      `http://127.0.0.1:${port}/replies/${channel}/${name}/${action}${query}`
    )
    assert.equal(response.status, 200, await response.clone().text())
    return response.json()
  }
  const recovery = (result) => result.jobs.find((job) => job.fn === "recover")
  // Retain each synthetic fault from creation, including while the other
  // channel is still being prepared. Keep-alive never advances domain work.
  await withOutageInstances(call, async (retain) => {
    for (const channel of ["email", "whatsapp"]) {
      await call(channel, "early", "setup")
      const deadline = Date.now() + 60_000
      await call(channel, "early", "arm", `?deadline=${Date.now()}`)
      await call(channel, "early", "arm", `?deadline=${deadline}`)
      const early = await call(channel, "early", "dispatch")
      assert.equal(recovery(early).payload.armedUntil, deadline)
      assert.equal(recovery(early).time, deadline)
      assert.equal(early.row, null)

      // An empty read starts before the lease expires. A row commits while the
      // scan is held, then its clock advances beyond the admission deadline.
      await call(channel, "scan", "setup")
      await call(channel, "scan", "arm", `?deadline=${deadline}`)
      await call(channel, "scan", "due")
      await call(channel, "scan", "hold-scan")
      const scanning = call(channel, "scan", "dispatch")
      for (let attempt = 0; ; attempt++) {
        if ((await call(channel, "scan", "status")).scanned) break
        assert.ok(attempt < 100, "scan barrier was not reached")
        await new Promise((done) => setTimeout(done, 10))
      }
      await call(channel, "scan", "accept", `?deadline=${deadline}`)
      await call(channel, "scan", "release", "?offset=61000")
      const scanned = await scanning
      assert.ok(
        recovery(scanned),
        "the overlapping acceptance lost its discovery job"
      )
      assert.equal(recovery(scanned).time, deadline)

      // A new same-ID push during native dispatch supersedes the old callback.
      await call(channel, "replace", "setup")
      await call(channel, "replace", "arm", `?deadline=${Date.now()}`)
      await call(channel, "replace", "hold-scan")
      const replacing = call(channel, "replace", "dispatch")
      for (let attempt = 0; ; attempt++) {
        if ((await call(channel, "replace", "status")).scanned) break
        assert.ok(attempt < 100, "replacement barrier was not reached")
        await new Promise((done) => setTimeout(done, 10))
      }
      await call(channel, "replace", "arm", `?deadline=${deadline}`)
      await call(channel, "replace", "release")
      assert.equal(recovery(await replacing).payload.armedUntil, deadline)

      for (const owner of ["pump", "discovery"]) {
        await call(channel, `exhaust-${owner}`, "setup")
        await call(channel, `exhaust-${owner}`, "lost-wake")
        await call(channel, `exhaust-${owner}`, `fault-${owner}`)
        await call(
          channel,
          `exhaust-${owner}`,
          owner === "pump" ? "wake" : "due"
        )
        const exhausted = await call(channel, `exhaust-${owner}`, "dispatch")
        assert.equal(exhausted.failures, 3)
        assert.equal(exhausted.row.state, "failed")
        assert.match(exhausted.row.error, /retry explicitly/)
        assert.equal(exhausted.metrics.sends, 0)
        assert.equal(
          exhausted.jobs.some((job) => job.fn === "pump"),
          false
        )
        assert.ok(
          recovery(exhausted),
          "future admission lease disappeared during failure handling"
        )
      }

      await call(channel, "checkpoint", "setup")
      await call(channel, "checkpoint", "lost-wake")
      await call(channel, "checkpoint", "fault-checkpoint")
      await call(channel, "checkpoint", "wake")
      await call(channel, "checkpoint", "dispatch")
      await call(channel, "checkpoint", "pump-due")
      const unconfirmed = await call(channel, "checkpoint", "dispatch")
      assert.equal(unconfirmed.row.state, "sending")
      assert.equal(unconfirmed.metrics.sends, 1)
      assert.ok(
        recovery(unconfirmed),
        "failed immediate recovery lost the armed deadline"
      )
      await call(channel, "checkpoint", "heal")
      const reconciled = await call(channel, "checkpoint", "dispatch")
      assert.equal(reconciled.row.state, "uncertain")
      assert.equal(reconciled.metrics.sends, 1)
      await call(channel, "checkpoint", "wake")
      const unchanged = await call(channel, "checkpoint", "dispatch")
      assert.equal(unchanged.row.state, "uncertain")
      assert.equal(unchanged.metrics.sends, 1)

      await prepareOutages(call, channel, retain)
    }
    // Both provider calls hold their real persisted 60s lease concurrently. No
    // fake clock or shortened production policy: dispatch must return on its own,
    // then a late non-abortable provider result must not overwrite an explicit retry.
    await Promise.all(
      ["email", "whatsapp"].map(async (channel) => {
        await call(channel, "held-provider", "setup")
        await call(channel, "held-provider", "hold-provider")
        await call(channel, "held-provider", "lost-wake")
        await call(channel, "held-provider", "wake")
        await call(channel, "held-provider", "dispatch")
        await call(channel, "held-provider", "pump-due")
        const began = Date.now()
        const timedOut = await call(channel, "held-provider", "dispatch")
        assert.equal(timedOut.providerStarted, true)
        assert.equal(timedOut.metrics.sends, 1)
        assert.equal(timedOut.row.state, "uncertain")
        assert.deepEqual(timedOut.row.delivery.receipts, [])
        assert.ok(
          Date.now() - began >= 55_000,
          "provider wait did not exercise its lease"
        )
        assert.ok(
          Date.now() - began < 75_000,
          "provider wait did not finish at its lease"
        )
        await call(channel, "held-provider", "retry")
        await call(channel, "held-provider", "dispatch")
        await call(channel, "held-provider", "pump-due")
        const retried = await call(channel, "held-provider", "dispatch")
        assert.equal(retried.row.state, "sent")
        assert.equal(retried.metrics.sends, 2)
        assert.deepEqual(retried.row.delivery.receipts, ["provider-confirmed"])
        await call(channel, "held-provider", "release-provider")
        const late = await call(channel, "held-provider", "status")
        assert.deepEqual(late.row, retried.row)
        assert.equal(late.metrics.sends, 2)
      })
    )
  })
  const orphanRestarts = new Map()
  for (const channel of ["email", "whatsapp"])
    orphanRestarts.set(channel, await finishOutages(call, channel))
  for (const channel of ["email", "whatsapp"]) {
    await call(channel, "restart", "setup")
    const lost = await call(channel, "restart", "lost-wake")
    assert.equal(lost.row.state, "queued")
    assert.equal(lost.metrics.sends, 0)
    assert.ok(recovery(lost))
  }
  for (const channel of ["email", "whatsapp"])
    await call(channel, "restart", "arm-restart")
  await stop("SIGKILL")
  await start(false)
  // No request to either object during this interval: native alarms must drive
  // recovery and both preparation/delivery pump passes after SIGKILL.
  await new Promise((done) => setTimeout(done, 8000))
  const firstReadAt = Date.now()
  for (const channel of ["email", "whatsapp"]) {
    const resumed = await call(channel, "restart", "status")
    assert.equal(resumed.row.state, "sent", JSON.stringify(resumed))
    assert.equal(resumed.metrics.sends, 1)
    assert.ok(resumed.metrics.automatic >= 2)
    assert.ok(resumed.metrics.lastSend < firstReadAt)
    assert.deepEqual(resumed.row.delivery.receipts, ["provider-confirmed"])
    const orphan = await call(channel, "outage-restart", "status")
    assert.equal(
      orphan.row.state,
      "failed",
      "startup woke an exhausted orphan before reconciliation"
    )
    assert.equal(orphan.row.id, orphanRestarts.get(channel).row.id)
    assert.equal(orphan.metrics.work, orphanRestarts.get(channel).metrics.work)
    assert.equal(orphan.metrics.sends, 0)
    assert.deepEqual(orphan.jobs, [])
  }
  console.log(
    "Reply outages: terminal domain-write failure, finite queue exhaustion, explicit status repair, newer-admission fencing, expired-work isolation and orphan SIGKILL restoration passed for email and WhatsApp."
  )
  console.log(
    "Reply discovery: empty-scan lease retention, commit-during-scan fencing, newer native queue intent, and lost-wake SIGKILL recovery via real alarms passed for email and WhatsApp."
  )
  console.log(
    "Attachment preparation: native SQLite request and PDF job survived SIGKILL and resumed with the original ID. Multipart email/WhatsApp: native receipt checkpoints, restart without resend, and explicit retry skipping confirmed parts passed. WhatsApp Chat SDK state: native SQLite facets, locking, list bounds and restart persistence passed."
  )
} finally {
  await stop()
  await rm(directory, { recursive: true, force: true })
}
