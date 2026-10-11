// No cloud bindings or credentials. Real workerd processes reuse only a disposable SQLite directory.
import { createRequire } from "node:module"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import assert from "node:assert/strict"

const requireAlchemy = createRequire(import.meta.resolve("alchemy"))
const { build } = requireAlchemy("esbuild")
const workerd = requireAlchemy("workerd")
const dir = await mkdtemp(join(tmpdir(), "durable-pi-mailbox-"))
let process,
  output = ""
const server = createServer()
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const address = server.address()
assert(address && typeof address !== "string")
const port = address.port
await new Promise((resolve) => server.close(resolve))
const origin = `http://127.0.0.1:${port}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const stop = async () => {
  if (!process || process.exitCode !== null) return
  const closed = new Promise((resolve) => process.once("exit", resolve))
  process.kill("SIGKILL")
  await closed
}
async function start() {
  process = spawn(workerd.default, ["serve", "-I/", "fixture.capnp"], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
  })
  process.stdout.on("data", (value) => {
    output += value
  })
  process.stderr.on("data", (value) => {
    output += value
  })
  for (let n = 0; n < 80; n++) {
    if (process.exitCode !== null)
      throw new Error(`Local workerd exited: ${output.slice(-5000)}`)
    try {
      if ((await fetch(`${origin}/health`)).ok) return
    } catch {
      /* startup only */
    }
    await sleep(100)
  }
  throw new Error(`Local workerd did not start: ${output.slice(-5000)}`)
}
async function call(path, identity, extra = {}) {
  const response = await fetch(`${origin}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identity, ...extra }),
  })
  assert(
    response.ok,
    `Fixture ${path}: ${response.status}; ${output.slice(-2000)}`
  )
  return response.json()
}
try {
  await mkdir(join(dir, "storage"))
  await build({
    entryPoints: [resolve("tests/runtime/communication-worker.ts")],
    outfile: join(dir, "worker.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: ["cloudflare:*", "node:*"],
    logLevel: "error",
  })
  const schema = join(
    dirname(requireAlchemy.resolve("workerd")),
    "..",
    "workerd.capnp"
  )
  await writeFile(
    join(dir, "fixture.capnp"),
    `using Workerd = import ${JSON.stringify(schema)};
const config :Workerd.Config = (
  services = [
    (name = "fixture", worker = (
      compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      bindings = [(name = "BOTS", durableObjectNamespace = (className = "MailboxBot")), (name = "LOOPS", durableObjectNamespace = (className = "LoopBot"))],
      durableObjectNamespaces = [(className = "MailboxBot", uniqueKey = "mailbox-local-test", enableSql = true), (className = "LoopBot", uniqueKey = "loops-local-test", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const a = { owner: "synthetic-owner", bot: "home" }
  const b = {
    owner: "synthetic-owner",
    bot: "00000000-0000-4000-8000-000000000001",
  }
  await call("configure", a)
  await call("configure", b)
  const now = Date.now()
  const envelope = {
    version: 1,
    id: "native-task-1",
    owner: a.owner,
    from: a.bot,
    to: b.bot,
    taskId: "native-task-1",
    correlationId: "synthetic-turn-1",
    causationId: "synthetic-tool-1",
    createdAt: now,
    deadline: now + 60000,
    depth: 1,
    payload: {
      kind: "question",
      objective: "What is 2 + 2?",
      context: "Synthetic fixture only.",
    },
  }
  await call("enqueue", a, { envelope, delay: 2500 })
  await stop()
  await start()
  let result
  for (let n = 0; n < 100; n++) {
    result = await call("inspect", a)
    if (result.tasks[0]?.status === "completed") break
    await sleep(150)
  }
  assert.equal(
    result.tasks[0]?.outcome?.text,
    "Deterministic result: 4",
    JSON.stringify(result) + output.slice(-5000)
  )
  const target = await call("inspect", b)
  assert.equal(target.tasks.length, 1)
  assert.equal(target.events.filter((e) => e.value === "execution").length, 1)
  assert(
    result.events.some((e) => e.value === "unrelated"),
    "Mailbox wake must preserve the unrelated Lifecycle job"
  )
  await call("enqueue", a, { envelope })
  await stop()
  await start()
  const recovered = await call("inspect", a)
  assert.equal(recovered.tasks.length, 1)
  assert.equal(recovered.tasks[0].outcome.text, "Deterministic result: 4")
  // Recipient commits acceptance, loses its acknowledgment, then its result waits
  // in SQLite while both isolates/processes are killed. Recovery needs no browser.
  await call("fault", b, { name: "drop-ack", value: 1 })
  await call("fault", b, { name: "result-delay", value: 4000 })
  const next = {
    ...envelope,
    id: "native-task-2",
    taskId: "native-task-2",
    createdAt: Date.now(),
    deadline: Date.now() + 60000,
  }
  await call("enqueue", a, { envelope: next })
  let middle
  for (let n = 0; n < 100; n++) {
    middle = await call("inspect", b)
    if (
      middle.tasks.find((t) => t.id === next.id)?.status === "completed" &&
      middle.events.some((e) => e.value === "lost-ack-after-commit")
    )
      break
    await sleep(100)
  }
  assert(
    middle.events.some((e) => e.value === "lost-ack-after-commit"),
    "Fault did not exercise a committed acceptance"
  )
  assert.equal(
    middle.deliveries.find((d) => d.envelope.taskId === next.id)?.status,
    "pending"
  )
  await stop()
  await start()
  for (let n = 0; n < 120; n++) {
    result = await call("inspect", a)
    if (result.tasks.find((t) => t.id === next.id)?.status === "completed")
      break
    await sleep(100)
  }
  assert.equal(
    result.tasks.find((t) => t.id === next.id)?.outcome?.text,
    "Deterministic result: 4",
    output.slice(-3000)
  )
  const recoveredRecipient = await call("inspect", b)
  assert.equal(recoveredRecipient.tasks.length, 2)
  assert.equal(
    recoveredRecipient.events.filter((e) => e.value === "execution").length,
    2
  )
  // Raw HTTP framing reaches the real schema decoder and authorization handlers.
  for (const invalid of [
    { ...next, version: 2 },
    { ...next, owner: "other-owner" },
    { ...next, payload: { ...next.payload, objective: "Forged replacement" } },
  ]) {
    const response = await fetch(`${origin}/raw`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: b, envelope: invalid }),
    })
    const text = await response.text()
    assert(
      text.includes('"Failure"') || text.includes('"Defect"'),
      "Invalid RPC unexpectedly succeeded"
    )
  }
  assert.equal((await call("inspect", b)).tasks.length, 2)
  // Actual PiHarness and its native alarm capability coexist with the mailbox.
  // Kill during a provider attempt, recover the same native submission and result.
  await call("fault", b, { name: "drop-ack", value: 0 })
  await call("fault", b, { name: "result-delay", value: 0 })
  await call("fault", b, { name: "native-pi", value: 1 })
  await call("fault", b, { name: "hold-pi", value: 1 })
  const piTask = {
    ...envelope,
    id: "native-pi-task-3",
    taskId: "native-pi-task-3",
    createdAt: Date.now(),
    deadline: Date.now() + 90000,
  }
  await call("enqueue", a, { envelope: piTask })
  let during
  for (let n = 0; n < 100; n++) {
    during = await call("inspect", b)
    if (during.events.some((e) => e.value === "pi-request")) break
    await sleep(100)
  }
  assert(
    during.events.some((e) => e.value === "pi-request"),
    "Pi attempt did not begin"
  )
  const nativeBefore = during.executions.find((e) => e !== null)
  assert(nativeBefore)
  await stop()
  await start()
  await call("fault", b, { name: "hold-pi", value: 0 })
  for (let n = 0; n < 350; n++) {
    result = await call("inspect", a)
    if (result.tasks.find((t) => t.id === piTask.id)?.resumed) break
    await sleep(150)
  }
  assert.equal(
    result.tasks.find((t) => t.id === piTask.id)?.outcome?.text,
    "Native Pi result: 4",
    JSON.stringify(result) + output.slice(-5000)
  )
  const nativeAfter = await call("inspect", b)
  assert.equal(nativeAfter.tasks.length, 3)
  assert.equal(
    nativeAfter.executions.find((e) => e !== null).conversation,
    nativeBefore.conversation
  )
  assert(nativeAfter.executions.find((e) => e !== null).requests <= 3)
  assert.equal(
    nativeAfter.events.filter((e) => e.value === "execution").length,
    3
  )
  assert.equal(
    result.events.filter((e) => e.value === "continuation").length,
    3
  )
  // Native tool-round checkpoint + run-owned detector survive an actual process kill.
  await call("loops/start", a)
  let loop
  for (let n = 0; n < 100; n++) {
    loop = await call("loops/inspect", a)
    if (loop.state?.view?.phase === "recovering") break
    await sleep(100)
  }
  assert.equal(
    loop.state?.view?.failures,
    3,
    JSON.stringify(loop) + output.slice(-4000)
  )
  assert.equal(loop.requests, 3)
  assert.equal(loop.receipts.length, 3)
  await stop()
  await start()
  const loopRestored = await call("loops/inspect", a)
  assert.equal(loopRestored.state.view.failures, 3)
  await call("loops/release", a)
  for (let n = 0; n < 200; n++) {
    loop = await call("loops/inspect", a)
    if (loop.state?.view?.phase === "blocked") break
    await sleep(100)
  }
  assert.equal(loop.state?.view?.failures, 5)
  assert.equal(loop.requests, 5)
  assert.equal(loop.receipts.length, 5)
  assert(loop.receipts.every((receipt) => receipt.status === "done"))
  await stop()
  await start()
  const loopBlocked = await call("loops/inspect", a)
  assert.equal(loopBlocked.state.view.phase, "blocked")
  assert.equal(loopBlocked.requests, 5)
  assert.equal(loopBlocked.receipts.length, 5)
  console.log(
    "PASS native loop recovery: SIGKILL at third failure, same committed round replayed once, fifth failure stops, blocked restart dispatches no new calls."
  )
  console.log(
    `PASS workerd ${workerd.version}: private Effect RPC, two SQLite DOs, sender restart before delivery, lost acknowledgment after acceptance, recipient/result-delivery restart, unique task admission, invalid/version/owner rejection native Pi interruption/recovery, single continuation and coexisting Pi/Lifecycle alarms.`
  )
} finally {
  await stop()
  await rm(dir, { recursive: true, force: true })
}
