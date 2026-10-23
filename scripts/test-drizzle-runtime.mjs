import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import {
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  readdir,
  readFile,
} from "node:fs/promises"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild")
const workerd = requireAlchemy("workerd")
const directory = await mkdtemp(join(tmpdir(), "durable-pi-drizzle-"))
let child,
  output = ""
const run = (command, args) =>
  new Promise((done, fail) => {
    const process = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    let captured = ""
    process.stdout.on("data", (data) => {
      captured += data
    })
    process.stderr.on("data", (data) => {
      captured += data
    })
    process.once("error", fail)
    process.once("exit", (code) =>
      code === 0 ? done(captured) : fail(new Error(captured))
    )
  })
const server = createServer()
await new Promise((done) => server.listen(0, "127.0.0.1", done))
const port = server.address().port
await new Promise((done) => server.close(done))
const origin = `http://127.0.0.1:${port}`
try {
  await mkdir(join(directory, "storage"))
  await run(process.execPath, [
    resolve("node_modules/drizzle-kit/bin.cjs"),
    "generate",
    "--dialect",
    "sqlite",
    "--driver",
    "durable-sqlite",
    "--schema",
    resolve("tests/runtime/drizzle-schema.ts"),
    "--out",
    join(directory, "migrations"),
    "--name",
    "probe",
  ])
  const files = await readdir(join(directory, "migrations"), {
    recursive: true,
  })
  const migrations = {}
  for (const file of files.filter((file) => file.endsWith(".sql"))) {
    const name = file.split("/")[0]
    migrations[name] = await readFile(
      join(directory, "migrations", file),
      "utf8"
    )
  }
  assert(
    Object.keys(migrations).length > 0,
    "Drizzle did not generate fixture DDL"
  )
  await build({
    entryPoints: [resolve("tests/runtime/drizzle-worker.ts")],
    outfile: join(directory, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    // Import the real state adapter without bundling unrelated Workers dev tooling.
    alias: {
      "alchemy/Cloudflare/Workers": join(
        dirname(requireAlchemy.resolve("alchemy")),
        "Cloudflare/Workers/DurableObjectState.js"
      ),
    },
    define: { DRIZZLE_PROBE_MIGRATIONS: JSON.stringify(migrations) },
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
      bindings = [(name = "PROBES", durableObjectNamespace = (className = "DrizzleProbe"))],
      durableObjectNamespaces = [(className = "DrizzleProbe", uniqueKey = "drizzle-probe-local", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  const start = async () => {
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
    for (let n = 0; n < 80; n++) {
      if (child.exitCode !== null) throw new Error(output)
      try {
        if ((await fetch(`${origin}/health`)).ok) break
      } catch {}
      await new Promise((done) => setTimeout(done, 100))
    }
  }
  const stop = async () => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return
    const stopped = new Promise((done) => child.once("exit", done))
    child.kill("SIGKILL")
    await stopped
  }
  await start()
  const modes = process.argv.slice(2)
  const selected = modes.length
    ? modes
    : [
        "commit",
        "rollback",
        "nested",
        "nested-caught",
        "nested-uncaught",
        "interrupt",
        "defect",
        "yield-rollback",
        "before-commit",
        "lost-ack",
        "stock-suspension",
        "pi-rollback-app-write",
        "app-rollback-pi-write",
        "external-interrupt",
        "rollback-settlement",
        "pi-rollback-app-statement",
        "app-rollback-lifecycle-write",
        "alchemy-commit",
        "alchemy-rollback",
        "alchemy-nested",
        "conversation-stream",
        "conversation-milestones",
        "conversation-handoff",
        ...[
          "commit",
          "rollback",
          "nested",
          "nested-caught",
          "nested-uncaught",
          "interrupt",
          "defect",
          "yield-rollback",
          "before-commit",
          "lost-ack",
          "rollback-settlement",
          "suspension",
          "uninterruptible-finalizer",
          "context",
          "escaped-builder",
          "detached-child",
          "pi-rollback-app-statement",
          "app-rollback-lifecycle-write",
          "queued-cancellation",
          "pi-harness",
          "migrations",
          "activity",
          "conversation-members",
          "conversation-activities",
          "access-operation",
          "agent-availability",
        ].map((mode) => `guarded-${mode}`),
      ]
  const snapshots = new Map()
  let accessOperations, agentAvailability
  for (const mode of selected) {
    const response = await fetch(`${origin}/${mode}`, {
      signal: AbortSignal.timeout(15000),
    }).catch((cause) => {
      throw new Error(`${mode} request failed: ${output.slice(-5000)}`, {
        cause,
      })
    })
    const result = await response.json()
    if (result.rows) snapshots.set(mode, result.rows)
    console.log(
      JSON.stringify({
        mode,
        status: response.status,
        ...Object.fromEntries(
          Object.entries(result).map(([key, value]) => [
            key,
            Array.isArray(value) &&
            key !== "reasons" &&
            !key.endsWith("Reasons")
              ? { count: value.length, first: value[0] }
              : value,
          ])
        ),
      })
    )
    assert.equal(response.status, 200, output.slice(-6000))
    const guarded = mode.startsWith("guarded-")
    const kind = guarded
      ? mode.slice("guarded-".length)
      : mode.startsWith("alchemy-")
        ? mode.slice("alchemy-".length)
        : mode
    const expected = {
      commit: [64, []],
      rollback: [0, ["Fail"]],
      nested: [64, []],
      "nested-caught": [1, []],
      "nested-uncaught": [0, ["Fail"]],
      interrupt: [0, ["Interrupt"]],
      defect: [0, ["Die"]],
      "yield-rollback": [0, ["Fail"]],
      "before-commit": [0, ["Fail"]],
      "lost-ack": [64, ["Fail"]],
      "external-interrupt": [1, ["Interrupt"]],
      "rollback-settlement": [0, guarded ? ["Fail", "Die"] : ["Fail", "Fail"]],
    }[kind]
    if (expected) {
      assert.equal(
        result.rows.length,
        expected[0],
        `${mode}: persisted row count`
      )
      assert.deepEqual(result.reasons, expected[1], `${mode}: completion cause`)
      assert.equal(
        result.finalized,
        true,
        `${mode}: callback finalization joined`
      )
      assert.deepEqual(
        result.persisted,
        result.rows,
        `${mode}: native and Effect reads agree`
      )
      if (result.outsideRows)
        assert.deepEqual(
          result.outsideRows,
          result.rows,
          `${mode}: outside reader waits for settlement`
        )
    }
    if (kind === "conversation-stream" || kind === "conversation-milestones")
      assert.deepEqual(result, {
        delivered: true,
        cursorFrames: 2,
        handoffFrames: kind === "conversation-milestones" ? 2 : 0,
        released: 1,
      })
    if (kind === "conversation-handoff")
      assert.deepEqual(result, {
        stages: [
          "control-start",
          "ready",
          "provider",
          "native",
          "enqueued",
          "yielded",
          "confirmed",
        ],
        capacityBounded: true,
        released: true,
        overflowReleased: true,
        abortReleased: true,
        privateDataAbsent: true,
      })
    if (kind === "agent-availability") {
      agentAvailability = result
      assert.deepEqual(
        Object.fromEntries(
          result.profiles.map((profile) => [profile.id, profile.status])
        ),
        {
          home: "active",
          "00000000-0000-4000-8000-000000000001": "active",
          "00000000-0000-4000-8000-000000000002": "archived",
        }
      )
      assert.equal(result.configuration.status, "archived")
      assert.equal(result.configuration.revision, 1)
      assert.deepEqual(result.generation, {
        schemaVersion: 1,
        workflowVersion: 1,
        membershipId: "new-membership",
      })
    }
    if (kind === "access-operation") {
      assert.equal(result.result, "saved receipt")
      assert.deepEqual(
        result.operations.map((operation) => operation.status),
        ["pending", "running", "running", "running", "done"]
      )
      accessOperations = result.operations
    }
    if (guarded) {
      if (kind === "conversation-activities") {
        assert.deepEqual(result.counts, [48, 49, 100])
        assert.equal(result.parity, true)
        assert.equal(result.singleTransactions, 100)
        assert.equal(result.bulkTransactions, 1)
        assert.deepEqual(result.replyCounts, [48, 49, 100])
        assert.equal(result.replyParity, true)
        assert.equal(result.replyVisibleOnly, true)
        assert.equal(result.visibleOnly, true)
        assert.equal(result.during, true)
        assert.equal(result.rollback, "Failure")
        assert.equal(result.afterRollback, 1)
      }
      if (kind === "conversation-members") {
        assert.deepEqual(result.counts, [48, 49, 100])
        assert.equal(result.hidden, true)
        assert.deepEqual(result.bindings, ["root-0", "root-99"])
        assert.equal(result.duringRollback, 2)
        assert.equal(result.rollback, "Failure")
        assert.equal(result.afterRollback, 1)
      }
      if (kind === "activity") {
        assert.equal(result.activity?.turn?.id, "native-activity")
        assert.equal(result.activity.rows[0]?.kind, "run")
        assert.equal(result.activity.rows[0]?.key, "accepted:native-activity")
      }
      if (kind === "migrations") {
        assert.equal(result.migrated, true)
        assert.deepEqual(
          result.retained,
          { text: "retained" },
          "Second migration activation retains live records"
        )
      }
      if (kind === "escaped-builder") {
        assert.notDeepEqual(result.reasons, [])
        assert.deepEqual(
          result.rows,
          [],
          "Escaped builder cannot execute without a live operation"
        )
      }
      if (kind === "detached-child") {
        assert.deepEqual(result.reasons, [])
        assert.notDeepEqual(result.childReasons, [])
        assert.deepEqual(result.rows, [{ id: 1, value: "committed" }])
      }
      if (kind === "pi-harness") {
        assert.equal(
          result.sameStorage,
          true,
          "PiHarness and factory retain the same coordinated store"
        )
        assert.equal(
          result.listedBeforeRelease,
          false,
          "PiHarness own storage reads must share the actor queue"
        )
        assert(result.sessionCount > 0)
        assert(result.observed.includes("scanConversations"))
      }
      if (kind === "context") {
        assert.deepEqual(result.reasons, [])
        assert.deepEqual(result.rows, [{ id: 1, value: "retained:1234" }])
      }
      if (kind === "suspension") {
        assert(result.reasons.includes("Die"))
        assert.equal(result.resumed, false, "Rejected callback must not resume")
        assert.deepEqual(result.rows, [])
      }
      if (kind === "uninterruptible-finalizer") {
        assert(result.reasons.includes("Die"))
        assert.equal(result.rolledBackBeforeCleanup, true)
        assert.notDeepEqual(
          result.finalizerReasons,
          [],
          "Revoked finalizer SQL must fail"
        )
        assert.deepEqual(
          result.rows,
          [],
          "Late uninterruptible finalizer must not persist rows"
        )
      }
      if (kind === "pi-rollback-app-statement") {
        assert.equal(result.returnedBeforePiRelease, false)
        assert.deepEqual(result.appReasons, [])
        assert.deepEqual(result.rows, [{ id: 1, value: "app-success" }])
      }
      if (kind === "app-rollback-lifecycle-write") {
        assert(result.appReasons.includes("Die"))
        assert.equal(
          result.savedJob?.id,
          "probe",
          "Acknowledged SDK job survives rejected app suspension"
        )
        assert.deepEqual(result.rows, [])
      }
      if (kind === "queued-cancellation") {
        assert.equal(result.cancellationJoinedBeforePiRelease, false)
        assert.deepEqual(result.reasons, ["Interrupt"])
        assert.deepEqual(
          result.rows,
          [],
          "Interrupted queued work must never execute"
        )
      }
    }
    if (mode === "stock-suspension") {
      assert.deepEqual(result.reasons, ["Die"])
      assert.equal(
        result.resumed,
        true,
        "Stock transaction abandoned fiber resumed"
      )
      assert.deepEqual(
        result.rows,
        [{ id: 2, value: "orphan" }],
        "Stock transaction reproduces upstream orphan regression"
      )
    }
    if (kind === "pi-rollback-app-write") {
      assert.equal(result.returnedBeforePiRelease, false)
      assert.equal(result.piError, true)
      assert.deepEqual(result.appReasons, [])
      assert.deepEqual(result.rows, [{ id: 1, value: "app-success" }])
    }
    if (kind === "app-rollback-pi-write") {
      assert.equal(result.piError, false)
      assert.equal(result.piDocuments, 1)
      assert.deepEqual(result.cached, { value: 1 })
      assert.deepEqual(result.rows, [])
    }
    if (mode === "pi-rollback-app-statement") {
      assert.equal(result.returnedBeforePiRelease, true)
      assert.deepEqual(result.appReasons, [])
      assert.deepEqual(
        result.rows,
        [],
        "Uncoordinated acknowledged app write is rolled back by Pi"
      )
    }
    if (mode === "app-rollback-lifecycle-write") {
      assert.equal(result.returnedBeforeAppRelease, true)
      assert.equal(
        result.savedJob,
        null,
        "Uncoordinated acknowledged SDK job is rolled back by application"
      )
    }
  }
  await stop()
  await start()
  for (const [mode, rows] of snapshots) {
    const response = await fetch(`${origin}/${mode}/inspect`, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200, `${mode}: restart inspection`)
    assert.deepEqual(
      (await response.json()).rows,
      rows,
      `${mode}: state survives native process restart`
    )
  }
  if (agentAvailability) {
    const response = await fetch(
      `${origin}/guarded-agent-availability/guarded-agent-restore`,
      { signal: AbortSignal.timeout(10000) }
    )
    assert.equal(
      response.status,
      200,
      "Agent availability restoration after SIGKILL"
    )
    const result = await response.json()
    assert.deepEqual(result.before, agentAvailability)
    assert.equal(result.replay.status, "active")
    assert.equal(result.replay.revision, 2)
    assert.deepEqual(result.stale, agentAvailability.configuration)
    assert.equal(result.current.status, "active")
    assert.equal(result.current.revision, 2)
    assert.equal(result.admitted.membershipId, "new-membership")
    assert.deepEqual(result.generation, agentAvailability.generation)
    const retained = await (
      await fetch(`${origin}/guarded-agent-availability/inspect`)
    ).json()
    assert.deepEqual(retained.rows, [{ id: 5, value: "one membership fence" }])
    console.log(
      "PASS Agent availability: native restart preserves profiles, raw creation replay, admission revision and membership generation without repeating cleanup."
    )
  }
  if (accessOperations) {
    const response = await fetch(
      `${origin}/guarded-access-operation/guarded-access-restore`,
      { signal: AbortSignal.timeout(10000) }
    )
    assert.equal(response.status, 200, "Access restoration after SIGKILL")
    const result = await response.json()
    assert.deepEqual(result.before, accessOperations)
    assert.equal(result.receipt, "saved receipt")
    assert.equal(result.pending, "pending")
    assert.equal(result.recovered, "execute")
    assert.equal(result.uncertain, true)
    assert.equal(result.revoked, true)
    assert.deepEqual(
      result.after.map((operation) => operation.status),
      ["denied", "interrupted", "done", "denied", "done"]
    )
    const retained = await (
      await fetch(`${origin}/guarded-access-operation/inspect`)
    ).json()
    assert.deepEqual(retained.rows, [{ id: 1, value: "one external effect" }])
    console.log(
      "PASS Access machine: native restart preserves receipts, waiting approval, recovery and revocation fences; one external effect."
    )
  }
  console.log(
    `PASS native Drizzle proof: ${selected.length} transaction/interoperability cases and ${snapshots.size} persisted-state checks after SIGKILL/restart.`
  )
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    const stopped = new Promise((done) => child.once("exit", done))
    child.kill("SIGKILL")
    await stopped
  }
  if (process.env.KEEP_DRIZZLE_PROBE)
    console.log(`Fixture retained: ${directory}`)
  else await rm(directory, { recursive: true, force: true })
}
