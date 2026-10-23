import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { get as getHttp } from "node:http"
import { createRequire } from "node:module"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"

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
// Terminal domain state can precede joined native cleanup. Capture complete
// rows for restart comparisons only after the owning pump releases control.
const conversationReleased = (turn) =>
  turn?.control?.owner === null && turn.control.deadline === null
const stop = async () => {
  if (!process || process.exitCode !== null || process.signalCode !== null)
    return
  const closed = new Promise((resolve) => process.once("exit", resolve))
  process.kill("SIGKILL")
  await closed
}
async function start() {
  process = spawn(
    workerd.default,
    ["serve", "--experimental", "-I/", "fixture.capnp"],
    {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
    }
  )
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
    } catch {}
    await sleep(100)
  }
  throw new Error(`Local workerd did not start: ${output.slice(-5000)}`)
}
async function call(path, identity, extra = {}) {
  const response = await fetch(`${origin}/${path}`, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    // This fixture repeatedly kills/restarts workerd and holds requests during
    // shutdown. Give each mutation a fresh socket instead of reusing an idle one.
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ identity, ...extra }),
  }).catch((cause) => {
    throw new Error(`Fixture ${path} request failed; ${output.slice(-6000)}`, {
      cause,
    })
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
    alias: {
      "cloudflare:email": resolve("tests/runtime/unused-cloudflare-email.ts"),
    },
    keepNames: true,
    logLevel: "error",
  })
  const schema = join(
    dirname(requireAlchemy.resolve("workerd")),
    "..",
    "workerd.capnp"
  )
  await build({
    entryPoints: [resolve("tests/runtime/chatgpt-provider-worker.ts")],
    outfile: join(dir, "chatgpt-provider.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    external: ["node:*"],
    logLevel: "error",
  })
  await writeFile(
    join(dir, "fixture.capnp"),
    `using Workerd = import ${JSON.stringify(schema)};
const config :Workerd.Config = (
  services = [
    (name = "fixture", worker = (
      compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat", "enable_request_signal"],
      modules = [(name = "worker.mjs", esModule = embed "worker.mjs")],
      globalOutbound = "chatgpt-provider",
      bindings = [(name = "MAINTENANCE", durableObjectNamespace = (className = "MaintenanceProbe")), (name = "WHATSAPP", durableObjectNamespace = (className = "WhatsAppSink")), (name = "SQL_PILOT", durableObjectNamespace = (className = "SqlitePilot")), (name = "LEGACY", durableObjectNamespace = (className = "LegacyAgentProbe")), (name = "TERMINALS", durableObjectNamespace = (className = "TerminalProbe")), (name = "BACKGROUND", durableObjectNamespace = (className = "BackgroundGroupProbe")), (name = "LOADER", workerLoader = (id = "native-code-local")), (name = "BROWSERS", durableObjectNamespace = (className = "BrowserRecoveryBot")), (name = "BOTS", durableObjectNamespace = (className = "MailboxBot")), (name = "LOOPS", durableObjectNamespace = (className = "LoopBot")), (name = "PERSONAL", durableObjectNamespace = (className = "PersonalAgentProbe"))],
      durableObjectNamespaces = [(className = "MaintenanceProbe", uniqueKey = "maintenance-local-test", enableSql = true), (className = "WhatsAppSink", uniqueKey = "whatsapp-sink-local-test", enableSql = true), (className = "SqlitePilot", uniqueKey = "sqlite-pilot-local-test", enableSql = true), (className = "LegacyAgentProbe", uniqueKey = "legacy-agent-local-test", enableSql = true), (className = "TerminalProbe", uniqueKey = "terminal-local-test", enableSql = true), (className = "BackgroundGroupProbe", uniqueKey = "background-local-test", enableSql = true), (className = "BrowserRecoveryBot", uniqueKey = "browser-local-test", enableSql = true), (className = "MailboxBot", uniqueKey = "mailbox-local-test", enableSql = true), (className = "LoopBot", uniqueKey = "loops-local-test", enableSql = true), (className = "PersonalAgentProbe", uniqueKey = "personal-local-test", enableSql = true)],
      durableObjectStorage = (localDisk = "storage")
    )),
    (name = "chatgpt-provider", worker = (
      compatibilityDate = ${JSON.stringify(workerd.compatibilityDate)}, compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "chatgpt-provider.mjs", esModule = embed "chatgpt-provider.mjs")]
    )),
    (name = "storage", disk = (path = "storage", writable = true))
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "fixture")]
);`
  )
  await start()
  const maintenanceState = () => call("maintenance/inspect", {})
  const waitMaintenance = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await maintenanceState()
      if (predicate(state)) return state
      await sleep(25)
    }
    throw new Error("Native maintenance scheduler did not progress")
  }
  await call("maintenance/start", {})
  await waitMaintenance((state) => state.calls === 1)
  await call("maintenance/foreground", {})
  const responsive = await waitMaintenance((state) => state.ticks === 1)
  assert.equal(
    (await call("personal-coordination/coordination-start", {})).status,
    202
  )
  let coordination
  for (let n = 0; n < 100; n++) {
    coordination = await call("personal-coordination/coordination-read", {})
    if (coordination.root?.status === "done") break
    await sleep(50)
  }
  assert.equal(
    coordination.root?.answer,
    "Parent free while child works",
    JSON.stringify(coordination) + output.slice(-2000)
  )
  assert.equal(coordination.root.provenance.author.kind, "human")
  assert.equal(
    coordination.root.provenance.author.id,
    "personal-coordination-owner"
  )
  assert.equal(coordination.groups[0].children[0].status, "working")
  assert(
    coordination.tasks.some(
      (task) =>
        task.kind === "request" &&
        task.id === coordination.root.id &&
        !task.terminal
    )
  )
  await call("personal-coordination/coordination-release", {})
  for (let n = 0; n < 200; n++) {
    coordination = await call("personal-coordination/coordination-read", {})
    if (
      coordination.latest?.lastReply?.text ===
        "Child conclusion after clarification" &&
      coordination.messages.some(
        (m) =>
          m.text === "Child conclusion after clarification" &&
          m.state === "delivered"
      ) &&
      coordination.turns.every((t) => t.status === "done")
    )
      break
    await sleep(50)
  }
  assert.equal(
    coordination.latest?.lastReply?.text,
    "Child conclusion after clarification",
    JSON.stringify(coordination) + output.slice(-4000)
  )
  assert.equal(
    coordination.groups[0].children[0].answer,
    "Child conclusion after clarification"
  )
  assert(
    coordination.messages.some(
      (m) => m.replyTo && m.text === "Use the private draft"
    )
  )
  assert(
    coordination.messages.every(
      (m) => m.provenance.author.kind === "agent" && m.state === "delivered"
    )
  )
  assert(coordination.turns.length > 1)
  assert(
    coordination.turns.every(
      (t) => t.session_id === coordination.root.session_id
    )
  )
  await call("personal-coordination/coordination-close", {})
  const fenced = await call(
    "personal-coordination/coordination-membership-fence",
    {}
  )
  assert.deepEqual(fenced.closed, Array(25).fill(true))
  assert.equal(fenced.message, "failed")
  assert.equal(fenced.retained, "done")
  console.log(
    "PASS native agent coordination: authenticated human provenance, nonblocking spawn, child discovery/question, addressed reply, automatic findings, resuming the original native session, and atomic membership fencing of 25 completed main sessions with queued mail and retained history."
  )
  assert.equal(
    responsive.applied,
    0,
    "Foreground must run while maintenance IO is still held"
  )
  assert.equal(
    responsive.jobs.length,
    1,
    "A durable recovery backstop must remain"
  )
  await call("maintenance/new-work", {})
  assert.equal(
    (await maintenanceState()).calls,
    1,
    "A wake must not overlap maintenance attempts"
  )
  await call("maintenance/release", {})
  await waitMaintenance(
    (state) => state.applied === 2 && state.jobs.length === 0
  )
  await call("maintenance/start", {})
  const heldAgain = await waitMaintenance((state) => state.calls === 3)
  assert.equal(heldAgain.applied, 2)
  await stop()
  await start()
  const recoveredMaintenance = await maintenanceState()
  assert.equal(recoveredMaintenance.applied, 2)
  assert.equal(
    recoveredMaintenance.jobs.length,
    1,
    "Maintenance wake must survive isolate loss"
  )
  await call("maintenance/release", {})
  await waitMaintenance(
    (state) => state.applied === 3 && state.jobs.length === 0
  )
  console.log(
    "PASS native maintenance: foreground progress during held IO, no overlapping attempts, wake during completion retained, and persisted recovery after SIGKILL."
  )
  const waitMaintenanceChat = async (predicate) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = await call("personal-maintenance/memory-chat-inspect", {})
      if (predicate(state)) return state
      await sleep(25)
    }
    throw new Error("Native chat waited for background maintenance")
  }
  await call("personal-maintenance/memory-chat-start", {})
  await waitMaintenanceChat(
    (state) => state.summaryEntered && state.backupEntered
  )
  await call("personal-maintenance/memory-chat-send", {})
  const chatDuringMaintenance = await waitMaintenanceChat(
    (state) => state.turn?.status === "done"
  )
  assert.equal(chatDuringMaintenance.ready, false)
  assert.equal(chatDuringMaintenance.backupHeld, true)
  assert.equal(chatDuringMaintenance.turn.answer, "Native actor answer")
  assert(
    chatDuringMaintenance.turn.prompt.includes("The exact cost is €42.75 🍀")
  )
  await call("personal-maintenance/memory-chat-release", {})
  console.log(
    "PASS native chat: production admission, context pinning, Pi reply and turn completion all finish while the summary model and backup IO remain held."
  )
  const nativeSignIn = await call("personal-chatgpt/chatgpt-native", {})
  assert.deepEqual(nativeSignIn, {
    status: 200,
    replay: 400,
    installed: true,
    consumed: true,
    provider: { exchanges: 1, unexpected: 0 },
  })
  assert.deepEqual(
    await call("personal-chatgpt/chatgpt-native?mode=redirect", {}),
    {
      ...nativeSignIn,
      status: 400,
      provider: { exchanges: 2, unexpected: 0 },
    }
  )
  console.log(
    "PASS native ChatGPT sign-in: default Workers fetch, PKCE exchange, remote JWKS identity validation, durable credential install, one-use replay and refused redirects."
  )
  const whatsappTimestamp = Date.now()
  assert.equal((await call("whatsapp/setup", {})).status, 200)
  assert.equal(
    (await call("whatsapp/receive", {}, { timestamp: whatsappTimestamp }))
      .accepted,
    true
  )
  assert.equal(
    (await call("whatsapp/receive", {}, { timestamp: whatsappTimestamp }))
      .accepted,
    false
  )
  let whatsapp
  for (let n = 0; n < 120; n++) {
    whatsapp = await call("whatsapp/inspect", {})
    if (whatsapp.states[0] === "sent") break
    await sleep(100)
  }
  assert.deepEqual(whatsapp.states, ["sent"])
  assert.equal(whatsapp.turns.length, 1)
  assert.equal(whatsapp.turns[0].origin.kind, "whatsapp")
  assert.equal(whatsapp.sends.length, 1)
  assert.match(whatsapp.sends[0].body, /Native actor answer/)
  const emailIdentity = { owner: "synthetic-email", bot: "home" }
  assert.equal((await call("whatsapp-images/setup", {})).status, 200)
  assert.equal(
    (
      await call(
        "whatsapp-images/receive",
        {},
        { timestamp: whatsappTimestamp }
      )
    ).accepted,
    true
  )
  let photos
  for (let n = 0; n < 250; n++) {
    photos = await call("whatsapp-images/inspect", {})
    if (
      photos.states.length === 1 &&
      photos.states.every((state) => state === "sent")
    )
      break
    await sleep(100)
  }
  assert.deepEqual(
    photos.states,
    ["sent"],
    JSON.stringify(photos) + output.slice(-10000)
  )
  assert.equal(photos.turns.length, 1)
  assert.equal(photos.turns[0].attachments, 1)
  assert.equal(photos.replyFiles.length, 1)
  assert.equal(photos.sends.length, 3)
  assert.equal(
    photos.sends
      .filter((send) => send.image === null)
      .map((send) =>
        send.body
          .replace(/^[^\n]+\n\n/, "")
          .replace(/\n\nhttps?:\/\/[^\s]+$/, "")
      )
      .join(""),
    photos.turns[0].answer
  )
  assert.ok(photos.turns[0].answer.endsWith("END OF FULL REPLY"))
  assert.equal(photos.sends.filter((send) => send.image !== null).length, 1)
  assert.equal(
    JSON.parse(photos.sends.find((send) => send.image !== null).image).mime,
    "image/jpeg"
  )
  assert.equal((await call("whatsapp-audio/setup", {})).status, 200)
  assert.equal(
    (await call("whatsapp-audio/receive", {}, { timestamp: whatsappTimestamp }))
      .accepted,
    true
  )
  let voice
  for (let n = 0; n < 250; n++) {
    voice = await call("whatsapp-audio/inspect", {})
    if (
      voice.states.length === 1 &&
      voice.states.every((state) => state === "sent")
    )
      break
    await sleep(100)
  }
  assert.deepEqual(
    voice.states,
    ["sent"],
    JSON.stringify(voice) + output.slice(-10000)
  )
  assert.equal(voice.turns[0].status, "done")
  assert.equal(voice.turns[0].attachments, 1)
  assert.equal(voice.turns[0].answer, "Native voice answer")
  assert.equal(voice.replyFiles.length, 0)
  assert.equal(voice.sends.length, 1)
  assert.equal(voice.sends[0].image, null)
  assert.ok(voice.sends[0].body.includes("Native voice answer"))
  assert.equal((await call("email/setup", emailIdentity)).status, 200)
  assert.equal((await call("email/invalid", emailIdentity)).status, 409)
  assert.equal((await call("email/receive", emailIdentity)).status, 202)
  assert.equal((await call("email/receive", emailIdentity)).status, 202)
  let email
  for (let n = 0; n < 120; n++) {
    email = await call("email/inspect", emailIdentity)
    if (email.states[0] === "sent") break
    await sleep(100)
  }
  assert.deepEqual(email.states, ["sent"])
  assert.equal(email.turns.length, 1)
  assert.equal(email.turns[0].origin.kind, "email")
  assert.equal(email.turns[0].answer, "Native actor answer")
  assert.equal(email.sends.length, 1)
  assert.match(email.sends[0].body, /Native actor answer/)
  await stop()
  await start()
  assert.deepEqual(await call("email/inspect", emailIdentity), email)
  assert.equal((await call("email/attachment", emailIdentity)).status, 202)
  for (let n = 0; n < 150; n++) {
    email = await call("email/inspect", emailIdentity)
    if (
      email.approvals.some((approval) => approval.tool === "share_file") &&
      email.sends.length === 2
    )
      break
    await sleep(100)
  }
  assert.equal(email.turns.length, 2)
  assert.ok(
    email.turns.some((turn) =>
      turn.attachments.some((file) => file.name === "acceptance.txt")
    )
  )
  assert.equal(email.sends.length, 2)
  assert.match(email.sends[1].body, /APPROVE /)
  assert.equal((await call("email/approve", emailIdentity)).status, 202)
  for (let n = 0; n < 150; n++) {
    email = await call("email/inspect", emailIdentity)
    if (
      email.states.length === 4 &&
      email.states.every((state) => state === "sent")
    )
      break
    await sleep(100)
  }
  assert.deepEqual(
    email.states,
    ["sent", "sent", "sent", "sent"],
    JSON.stringify({
      states: email.states,
      operations: email.operations,
      replyFiles: email.replyFiles,
      turns: email.turns,
      approvals: email.approvals.map(({ tool, status }) => ({ tool, status })),
      replies: email.sends.map((send) => send.body.split("\n")[0]),
    })
  )
  assert.equal(
    email.turns.length,
    2,
    "Approval commands must not become model turns"
  )
  assert.equal(email.sends.length, 4)
  assert.ok(
    email.sends.some((send) =>
      JSON.parse(send.attachments).some(
        (file) => file.name === "acceptance.txt" && file.bytes === 27
      )
    )
  )
  assert.ok(
    email.sends.every((send) =>
      send.body.includes("/agents/personal-assistant")
    )
  )

  assert.equal(
    (await call("personal-chatgpt/chatgpt-native?mode=inspect", {})).installed,
    true
  )
  assert.equal(
    (
      await call(
        "whatsapp-images/receive",
        {},
        { timestamp: whatsappTimestamp }
      )
    ).accepted,
    false
  )
  assert.deepEqual(await call("whatsapp-images/inspect", {}), photos)
  assert.equal(
    (await call("whatsapp-audio/receive", {}, { timestamp: whatsappTimestamp }))
      .accepted,
    false
  )
  assert.deepEqual(await call("whatsapp-audio/inspect", {}), voice)
  console.log(
    "PASS native voice: shared original/transcript storage, agent transcript input and text reply, dedupe and restart without resend; AI/provider inference is synthetic."
  )
  console.log(
    "PASS native WhatsApp images: production workspace upload and vision admission, common share_image tool, complete multipart text and a private image send, dedupe and restart persistence."
  )
  assert.equal(
    (await call("whatsapp/receive", {}, { timestamp: whatsappTimestamp }))
      .accepted,
    false
  )
  assert.deepEqual(await call("whatsapp/inspect", {}), whatsapp)
  console.log(
    "PASS native WhatsApp: production actor admission, one Pi reply, webhook dedupe and sent restart without resend."
  )
  assert.equal((await call("email-held/setup", emailIdentity)).status, 200)
  await call("email-held/hold", emailIdentity)
  await call("email-held/receive", emailIdentity)
  let heldEmail
  for (let n = 0; n < 120; n++) {
    heldEmail = await call("email-held/inspect", emailIdentity)
    if (heldEmail.states[0] === "sending") break
    await sleep(100)
  }
  assert.deepEqual(heldEmail.states, ["sending"])
  assert.equal(heldEmail.sends.length, 1)
  await stop()
  await start()
  const recoveredEmail = await call("email-held/inspect", emailIdentity)
  assert.deepEqual(recoveredEmail.states, ["uncertain"])
  assert.equal(recoveredEmail.sends.length, 1)
  assert.equal((await call("email-held/receive", emailIdentity)).status, 202)
  assert.equal(
    (await call("email-held/inspect", emailIdentity)).sends.length,
    1
  )
  console.log(
    "PASS native email: MIME to production actor, one Pi reply, webhook dedupe, sent restart, and SIGKILL during provider send without resend."
  )
  // Chunk boundaries are transport details (including empty gzip chunks).
  const nextFrame = (reader) => {
    let pending = ""
    const decoder = new TextDecoder()
    return async () => {
      while (!pending.includes("\n\n")) {
        const next = await reader.read()
        assert.equal(next.done, false, "SSE ended before its next frame")
        pending += decoder.decode(next.value, { stream: true })
      }
      const end = pending.indexOf("\n\n") + 2
      const frame = pending.slice(0, end)
      pending = pending.slice(end)
      return frame
    }
  }
  const encoded = await fetch(`${origin}/encoding/stream?id=delivery`, {
    headers: { "accept-encoding": "gzip" },
    signal: AbortSignal.timeout(5000),
  })
  assert.equal(encoded.status, 200, output.slice(-5000))
  assert.equal(encoded.headers.get("content-encoding"), "gzip")
  assert.equal(encoded.headers.get("cache-control"), "private, no-store")
  const encodedReader = encoded.body.getReader()
  const frame = nextFrame(encodedReader)
  assert.equal(await frame(), "data: first\n\n")
  assert.equal(await frame(), ": keepalive\n\n")
  await encodedReader.cancel()
  // Destroy the TCP socket explicitly. A Fetch reader cancellation can tear
  // down gently without making workerd observe the disconnect promptly.
  await new Promise((done, fail) => {
    const pending = getHttp(
      `${origin}/encoding/stream?id=disconnect`,
      { headers: { "accept-encoding": "gzip" } },
      (response) => {
        response.on("error", () => {})
        response.once("data", () => {
          response.socket.destroy()
          done()
        })
      }
    )
    pending.on("error", fail)
    pending.setTimeout(5000, () =>
      pending.destroy(new Error("Encoding probe timed out"))
    )
  })
  let encodingCancellations = 0
  for (let n = 0; n < 20; n++) {
    encodingCancellations = (
      await (await fetch(`${origin}/encoding/state?id=disconnect`)).json()
    ).cancellations
    if (encodingCancellations) break
    await sleep(50)
  }
  assert.equal(encodingCancellations, 1)
  // Assert the adapter's error before the HTTP server chooses how to close
  // a response whose headers are already sent (workerd may send a clean EOF).
  const failedEncoding = await fetch(`${origin}/encoding/probe-failure`, {
    headers: { "accept-encoding": "gzip" },
    signal: AbortSignal.timeout(5000),
  })
  assert.deepEqual(await failedEncoding.json(), {
    received: true,
    failed: true,
  })
  console.log(
    "PASS website SSE gzip: small initial event and later heartbeat arrive before EOF, cloned Response is encoded once, cancellation reaches the source exactly once and a late source error fails the native body reader."
  )
  const sqlPilot = {}
  for (const mode of [
    "commit",
    "rollback",
    "nested",
    "nested-caught",
    "nested-uncaught",
    "interrupt",
    "defect",
    "yield-rollback",
    "query-only",
    "native-sync",
    "before-commit",
    "lost-ack",
    "foreign-key",
  ]) {
    const response = await fetch(`${origin}/sql-pilot/${mode}`, {
      signal: AbortSignal.timeout(15000),
    })
    if (mode === "foreign-key" && response.status === 500) {
      const inspected = await fetch(`${origin}/sql-pilot/foreign-key/inspect`)
      assert.equal(
        inspected.status,
        200,
        `commit failure recovery: ${await inspected.clone().text()} ${output.slice(-4000)}`
      )
      sqlPilot[mode] = { nativeStatus: 500, recovered: await inspected.json() }
    } else {
      assert.equal(
        response.status,
        200,
        `${mode}: ${await response.clone().text()} ${output.slice(-4000)}`
      )
      sqlPilot[mode] = await response.json()
    }
  }
  const sqlCounts = {
    commit: 64,
    rollback: 0,
    nested: 64,
    "nested-caught": 1,
    "nested-uncaught": 0,
    interrupt: 0,
    defect: 0,
    "yield-rollback": 0,
    "query-only": 0,
    "native-sync": 0,
    "before-commit": 0,
    "lost-ack": 1,
  }
  const sqlReasons = {
    commit: [],
    rollback: ["Fail"],
    nested: [],
    "nested-caught": [],
    "nested-uncaught": ["Fail"],
    interrupt: ["Interrupt"],
    defect: ["Die"],
    "yield-rollback": ["Fail"],
    "query-only": ["Fail"],
    "native-sync": ["Fail"],
    "before-commit": ["Fail"],
    "lost-ack": ["Fail"],
  }
  for (const [mode, count] of Object.entries(sqlCounts)) {
    assert.equal(sqlPilot[mode].admitted, mode !== "query-only")
    assert.deepEqual(sqlPilot[mode].rows, [{ n: count }], mode)
    assert.deepEqual(sqlPilot[mode].outsideRows, [{ n: count }], mode)
    assert.equal(sqlPilot[mode].persisted, count, mode)
    assert.deepEqual(sqlPilot[mode].reasons, sqlReasons[mode], mode)
  }
  for (const mode of ["query-only", "before-commit", "lost-ack"])
    assert.deepEqual(sqlPilot[mode].errors, ["SqlError"])
  if (sqlPilot["foreign-key"].nativeStatus === 500)
    assert.deepEqual(sqlPilot["foreign-key"].recovered, {
      persisted: 0,
      children: 0,
    })
  else {
    assert.deepEqual(sqlPilot["foreign-key"].errors, ["SqlError"])
    assert.equal(sqlPilot["foreign-key"].children, 0)
  }
  for (const mode of Object.keys(sqlPilot))
    assert.equal(
      (await fetch(`${origin}/sql-pilot/${mode}/dispose`)).status,
      200
    )
  console.log(
    "PASS native Effect SQLite DO driver: rollback/nesting/interruption/defect, automatic yields with a queued reader, native synchronous writes, query-only rejection, pre-commit failure, lost acknowledgement with committed state and real commit-failure recovery."
  )
  const nativeAuthority = await fetch(`${origin}/native-terminal/authority`, {
    method: "POST",
    body: JSON.stringify({ revision: 0, active: true }),
  })
  assert.equal(
    nativeAuthority.status,
    200,
    output.slice(-6000) + (await nativeAuthority.text())
  )
  const nativeVideo = await fetch(`${origin}/native-terminal/video`, {
    method: "POST",
    body: Uint8Array.of(1),
  })
  assert.equal(nativeVideo.status, 200, output.slice(-6000))
  assert.equal(nativeVideo.headers.get("x-probe-video-closes"), "2")
  assert.deepEqual(await nativeVideo.json(), {
    duration: 2,
    frames: [{ at: 1, jpeg: "/9j/4AAQ" }],
    captions: "synthetic",
    captionsTruncated: false,
  })
  const terminalFetch = (path, body) =>
    fetch(
      `${origin}/native-terminal/${path}`,
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) }
    )
  const nativeCommand = await (await terminalFetch("client", {})).json()
  assert.equal(nativeCommand.status, "succeeded", output.slice(-4000))
  assert.equal(nativeCommand.output, "Native shell command")
  assert.deepEqual(
    await (await terminalFetch("client", {})).json(),
    nativeCommand
  )
  assert.equal(
    (await terminalFetch("terminal/session", { id: "native-pty" })).status,
    202
  )
  for (let n = 0; n < 40; n++) {
    const state = await (await terminalFetch("terminal")).json()
    if (state.session?.phase === "ready") break
    if (n === 39)
      throw new Error("Native interactive session did not become ready")
    await sleep(25)
  }
  const socketEvent = (socket, type) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        socket.close()
        reject(new Error(`Native socket ${type} timed out`))
      }, 6000)
      const cleanup = () => {
        clearTimeout(timer)
        socket.removeEventListener(type, event)
        socket.removeEventListener("error", error)
      }
      const event = (value) => {
        cleanup()
        resolve(value)
      }
      const error = () => {
        cleanup()
        reject(new Error(`Native socket ${type} failed`))
      }
      socket.addEventListener(type, event, { once: true })
      socket.addEventListener("error", error, { once: true })
    })
  const socketUrl = `${origin.replace("http:", "ws:")}/native-terminal/terminal/session/native-pty/socket`
  const panel = new WebSocket(socketUrl)
  panel.binaryType = "arraybuffer"
  await socketEvent(panel, "open")
  const binaryEcho = socketEvent(panel, "message")
  panel.send(Uint8Array.of(97, 98))
  const echoedBinary = (await binaryEcho).data
  assert.deepEqual(
    new Uint8Array(echoedBinary),
    Uint8Array.of(97, 98),
    `Native relay frame type ${typeof echoedBinary}/${echoedBinary?.constructor?.name}: ${String(echoedBinary)}`
  )
  const resizeEcho = socketEvent(panel, "message"),
    resize = JSON.stringify({ type: "resize", cols: 80, rows: 24 })
  panel.send(resize)
  assert.equal((await resizeEcho).data, resize)
  const panelClosed = socketEvent(panel, "close")
  panel.close()
  await panelClosed
  const invalidPanel = new WebSocket(socketUrl)
  await socketEvent(invalidPanel, "open")
  const invalidClosed = socketEvent(invalidPanel, "close")
  invalidPanel.send("whoami")
  await invalidClosed
  assert.equal(
    (await terminalFetch("terminal/session/native-pty/save", {})).status,
    200
  )
  const nativeTerminalState = await (await terminalFetch("inspect")).json()
  assert.deepEqual(nativeTerminalState.commands, [
    { command: "printf fixture" },
  ])
  assert(
    nativeTerminalState.state.runs.some(
      (run) => run.id === "native-pty" && run.status === "succeeded"
    )
  )
  console.log(
    "PASS native Terminal client and relay: one original command/replay, real WebSocket binary/resize relay, disconnect/reconnect, invalid input closes, and session Save/checkpoint."
  )
  assert.equal(
    (await fetch(`${origin}/personal-terminal/setup`, { method: "POST" }))
      .status,
    200
  )
  const proxyTerminal = (path, body) =>
    fetch(
      `${origin}/personal-terminal/terminal${path}`,
      body === undefined
        ? undefined
        : { method: "POST", body: JSON.stringify(body) }
    )
  const proxyAdmission = await proxyTerminal("/session", {
    id: "native-host-pty",
  })
  assert.equal(proxyAdmission.status, 202, await proxyAdmission.text())
  for (let n = 0; n < 40; n++) {
    const state = await (await proxyTerminal("")).json()
    if (state.session?.phase === "ready") break
    if (n === 39) throw new Error("Host Terminal session did not become ready")
    await sleep(25)
  }
  const hostPanel = new WebSocket(
    `${origin.replace("http:", "ws:")}/personal-terminal/terminal/session/native-host-pty/socket`
  )
  hostPanel.binaryType = "arraybuffer"
  await socketEvent(hostPanel, "open")
  const hostEcho = socketEvent(hostPanel, "message")
  hostPanel.send(Uint8Array.of(65, 66))
  assert.deepEqual(new Uint8Array((await hostEcho).data), Uint8Array.of(65, 66))
  const hostResize = socketEvent(hostPanel, "message")
  hostPanel.send(resize)
  assert.equal((await hostResize).data, resize)
  const hostClosed = socketEvent(hostPanel, "close")
  hostPanel.close()
  await hostClosed
  assert.equal(
    (await proxyTerminal("/session/native-host-pty/save", {})).status,
    200
  )
  console.log(
    "PASS native PersonalAgent HTTP proxy: actual retained host, Terminal session admission, WebSocket upgrade, binary/resize relay and Save."
  )
  const nativeExecution = async (code, data = "null") => {
    const response = await fetch(`${origin}/native-execution`, {
      method: "POST",
      body: JSON.stringify({ code, data }),
    })
    assert.equal(
      response.status,
      200,
      output.slice(-4000) + (await response.clone().text())
    )
    return response.json()
  }
  const calculated = await nativeExecution(
    'console.log("synthetic"); return input.reduce((sum, n) => sum + n, 0)',
    "[1,2,3]"
  )
  assert.equal(calculated.result, "6")
  assert.equal(calculated.error, null)
  assert.match(calculated.logs, /synthetic/)
  const isolated = await nativeExecution(
    'return await fetch("https://execution-test.invalid")'
  )
  assert.equal(isolated.result, "")
  assert(isolated.error)
  const oversizedResult = await nativeExecution('return "x".repeat(32769)')
  assert.equal(oversizedResult.result, "")
  assert.match(oversizedResult.error, /32768/)
  const boundedLogs = await nativeExecution(
    'console.log("x".repeat(20000)); return 1'
  )
  assert.equal(boundedLogs.logs.length, 16000)
  assert.equal(boundedLogs.result, "1")
  const boundedError = await nativeExecution(
    'throw new Error("x".repeat(2000))'
  )
  assert.equal(boundedError.error.length, 1000)
  console.log(
    "PASS native Dynamic Worker Loader: production Execution handler, bundled runner/code loading, bounded JSON/logs, outbound network denied."
  )
  const traces = await Promise.all(
    [1, 2].map(() => fetch(`${origin}/telemetry`).then((r) => r.json()))
  )
  assert.notEqual(traces[0].id, traces[1].id)
  for (const trace of traces) {
    assert.equal(trace.name, "fixture.request")
    assert.equal(trace.child.name, "fixture.child")
    assert.equal(trace.child.parent, trace.id)
  }
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
  const browserRejected = await call("browser/rejected", a)
  assert.equal(browserRejected.receipt, "done")
  assert.equal(browserRejected.result.isError, true)
  assert.match(
    browserRejected.result.output[0].text,
    /enable unrestricted internet/
  )
  assert.equal(browserRejected.actions, 0)
  const browserUncertain = await call("browser/uncertain", a)
  assert.equal(browserUncertain.receipt, "running")
  assert.match(browserUncertain.error, /may have run/)
  assert.equal(browserUncertain.actions, 1)
  await stop()
  await start()
  assert.deepEqual(await call("browser/rejected", a), browserRejected)
  const browserRestored = await call("browser/uncertain", a)
  assert.equal(browserRestored.receipt, "interrupted")
  assert.equal(browserRestored.actions, 1)
  assert.match(browserRestored.error, /outcome is unknown/)
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
  assert.deepEqual(loopRestored.activity, loop.activity)
  assert.equal(
    loopRestored.activity.events.filter((event) => event.kind === "tool")
      .length,
    3
  )
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
  assert.deepEqual(loopBlocked.activity, loop.activity)
  assert.equal(
    loopBlocked.activity.events.filter((event) => event.kind === "tool").length,
    5
  )
  assert(
    loopBlocked.activity.events
      .filter((event) => event.kind === "tool")
      .every(
        (event) =>
          event.transitions.map((t) => t.status).join(",") ===
          "approved,running,done"
      )
  )
  assert(
    loopBlocked.activity.events.some(
      (event) => event.kind === "recovery" && event.status === "blocked"
    )
  )
  console.log(
    "PASS native loop recovery: SIGKILL at third failure, same committed round replayed once, fifth failure stops, blocked restart dispatches no new calls."
  )
  await call("personal/admit", a)
  let personal
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (personal.turn?.status === "done") break
    await sleep(100)
  }
  assert.equal(
    personal.turn?.answer,
    "Native actor answer",
    JSON.stringify(personal) + output.slice(-4000)
  )
  assert.equal(personal.attempts, 1)
  const sqlJournal = await call("personal/sql-journal-probe", a)
  assert(sqlJournal.entries > 0)
  assert.equal(sqlJournal.matches, true)
  assert.equal(sqlJournal.unchanged, true)
  console.log(
    "PASS native Effect SQL read compatibility with the actual committed Pi journal, without mutation or a second harness."
  )
  for (const mode of ["expected", "defect", "interrupt", "mixed", "invalid"]) {
    const result = await call("personal/http-api-probe", a, { mode })
    if (mode === "expected") {
      assert.equal(result.status, 400)
      assert.deepEqual(result.body, {
        error:
          "The request could not be completed. Your saved messages are safe.",
      })
    } else {
      assert(
        result.reasons.includes(mode === "interrupt" ? "Interrupt" : "Die"),
        JSON.stringify(result)
      )
      assert.equal(result.status, undefined)
    }
  }
  console.log(
    "PASS native retained HttpApi catalog: preserved wire/status, safe expected failure, fatal defect/interruption/compound cause and invalid-result rejection."
  )
  for (const kind of ["objects", "planning", "delegation"]) {
    for (const mode of ["callback", "raw", "compound", "late"]) {
      const result = await call("personal/pi-commit-probe", a, { kind, mode })
      assert.equal(
        result.callback,
        true,
        JSON.stringify({ kind, mode, result })
      )
      assert.equal(result.joined, true)
      assert.equal(result.unchanged, true)
      if (mode === "callback") assert.deepEqual(result.reasons, ["Fail"])
      else {
        assert.equal(result.native, true)
        assert(result.reasons.includes("Die"))
        if (mode !== "raw") assert(result.reasons.includes("Interrupt"))
      }
    }
  }
  console.log(
    "PASS native Objects/Planning/Delegation commits: callback rollback, separate raw/compound settlement faults and joined late defects retain both causes without changing Pi journal entries."
  )

  assert.equal(personal.externalCalls, 0)
  const rpcOutcomes = await call("personal/background-rpc-probe", a)
  assert.deepEqual(
    rpcOutcomes.filter((item) => item.protocol === "v1"),
    [
      {
        protocol: "v1",
        kind: "expected",
        reasons: [{ tag: "Fail", code: "cancelled" }],
      },
      { protocol: "v1", kind: "defect", reasons: [{ tag: "Die" }] },
      { protocol: "v1", kind: "interrupt", reasons: [{ tag: "Interrupt" }] },
      {
        protocol: "v1",
        kind: "mixed",
        reasons: [
          { tag: "Fail", code: "cancelled" },
          { tag: "Die" },
          { tag: "Interrupt" },
        ],
      },
      { protocol: "v1", kind: "invalid", reasons: [{ tag: "Die" }] },
    ]
  )
  assert.deepEqual(
    rpcOutcomes.filter((item) => item.protocol === "legacy"),
    [
      {
        protocol: "legacy",
        kind: "expected",
        reasons: [{ tag: "Fail", code: "cancelled" }],
      },
      {
        protocol: "legacy",
        kind: "defect",
        reasons: [{ tag: "Fail", code: "unavailable" }],
      },
      {
        protocol: "legacy",
        kind: "interrupt",
        reasons: [{ tag: "Fail", code: "unavailable" }],
      },
      {
        protocol: "legacy",
        kind: "mixed",
        reasons: [{ tag: "Fail", code: "cancelled" }],
      },
    ]
  )
  console.log(
    "PASS native BackgroundGroup RPC: explicit Exit preserves expected failures, defects, interruption and compound Causes; legacy Promise projection demonstrates the lost meanings."
  )
  const parentOutcomes = await call("personal/parent-rpc-probe", a)
  assert.deepEqual(
    parentOutcomes,
    ["parent", "account"].flatMap((boundary) => [
      { boundary, kind: "expected", reasons: ["Fail"] },
      { boundary, kind: "defect", reasons: ["Die"] },
      { boundary, kind: "interrupt", reasons: ["Interrupt"] },
      { boundary, kind: "mixed", reasons: ["Fail", "Die", "Interrupt"] },
    ])
  )
  console.log(
    "PASS native reverse parent/account RPC: retained host handlers preserve complete Causes through actual DO calls in both directions."
  )
  const ownerOutcomes = await call("personal/owner-rpc-probe", a)
  assert.deepEqual(ownerOutcomes.definitions, [])
  assert.deepEqual(ownerOutcomes.skills, [])
  assert.deepEqual(
    ownerOutcomes.outcomes,
    ["connection", "call", "skill"].flatMap((boundary) => [
      { boundary, kind: "expected", reasons: ["Fail"] },
      { boundary, kind: "defect", reasons: ["Die"] },
      { boundary, kind: "interrupt", reasons: ["Interrupt"] },
      { boundary, kind: "mixed", reasons: ["Fail", "Die", "Interrupt"] },
      { boundary, kind: "invalid", reasons: ["Die"] },
    ])
  )
  console.log(
    "PASS native connection/tool/skill owner RPC: actual retained handlers preserve complete outcomes, reject invalid operations and redact private diagnostics across DO calls."
  )
  const agentOutcomes = await call("personal/agent-rpc-probe", a)
  assert.deepEqual(
    agentOutcomes.outcomes,
    ["profiles", "status", "configure", "connection"].flatMap((boundary) => [
      { boundary, kind: "expected", reasons: ["Fail"] },
      { boundary, kind: "defect", reasons: ["Die"] },
      { boundary, kind: "interrupt", reasons: ["Interrupt"] },
      { boundary, kind: "mixed", reasons: ["Fail", "Die", "Interrupt"] },
    ])
  )
  assert.deepEqual(agentOutcomes.legacy.contacts, [
    { id: "home", name: "Legacy bot" },
  ])
  assert.equal(agentOutcomes.legacy.profile.name, "Legacy bot")
  assert.equal(agentOutcomes.legacy.profile.id, "home")
  assert.equal(agentOutcomes.legacy.profiles.length, 1)
  assert.deepEqual(agentOutcomes.legacy.status, {
    state: "ready",
    turnId: null,
  })
  assert.equal(agentOutcomes.legacy.connected, true)
  assert.equal(
    agentOutcomes.legacy.saved.configuration.communicationOwner,
    "legacy-owner"
  )
  assert.deepEqual(agentOutcomes.legacy.saved.prepared, {
    owner: "legacy-owner",
    id: "home",
  })
  console.log(
    "PASS native profile/status/configuration/connection RPC: complete outcomes and actual previous-version DO fallback, including owner and mailbox identity arguments."
  )
  const activityOutcomes = await call("personal/activity-rpc-probe", a)
  assert.deepEqual(
    activityOutcomes.outcomes,
    ["snapshot", "conversation", "webhook"].flatMap((boundary) => [
      { boundary, kind: "expected", reasons: ["Fail"] },
      { boundary, kind: "defect", reasons: ["Die"] },
      { boundary, kind: "interrupt", reasons: ["Interrupt"] },
      { boundary, kind: "mixed", reasons: ["Fail", "Die", "Interrupt"] },
      { boundary, kind: "invalid", reasons: ["Die"] },
    ])
  )
  assert.deepEqual(
    activityOutcomes.directoryFailures.map((reasons) =>
      reasons.map((reason) => reason._tag)
    ),
    [["ActivityUnavailable"], ["ActivityUnavailable"], ["ActivityUnavailable"]]
  )
  assert.deepEqual(activityOutcomes.legacy, {
    snapshot: { entries: [], issues: [] },
    conversation: null,
    authorized: false,
  })
  for (const path of [
    "bots",
    "state",
    "tasks",
    "activity?scope=all",
    "bots/statuses",
  ]) {
    const response = await fetch(`${origin}/gateway/${path}`)
    assert.equal(
      response.status,
      200,
      `${path}: ${await response.clone().text()} ${output.slice(-4000)}`
    )
    const body = await response.json()
    if (path === "bots") assert.equal(body.agents[0].id, "home")
    if (path === "state") assert.equal(typeof body.connected, "boolean")
    if (path.startsWith("activity")) assert(Array.isArray(body.entries))
    if (path === "bots/statuses") assert.equal(body.statuses[0].agentId, "home")
  }
  const taskControls = await call("personal-tasks/task-controls", {})
  assert.deepEqual(
    taskControls.before.map((task) => task.id),
    ["original-task", "newer-task"]
  )
  assert(["stopping", "cancelled"].includes(taskControls.stopped.state))
  assert(["stopping", "cancelled"].includes(taskControls.replay.state))
  assert.notEqual(taskControls.newerState, "cancelled")
  assert.equal(taskControls.originalSession, null)
  console.log(
    "PASS native task controls: original records, queued cancellation before model dispatch, exact retry and a newer request preserved."
  )
  const liveRevision = await (await fetch(`${origin}/deployment`)).json()
  assert.equal(liveRevision.worker, "development")
  assert(liveRevision.agents.length >= 1)
  assert(liveRevision.agents.every((revision) => revision === "development"))
  console.log(
    "PASS native read-only deployment revisions through the production Worker and actual PersonalAgent catalogue/actors."
  )
  const denied = await fetch(
    `${origin}/gateway/webhooks/incoming?routine=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
    {
      method: "POST",
      headers: { authorization: `Bearer rpwh_${"a".repeat(64)}` },
      body: "{}",
    }
  )
  assert.equal(denied.status, 401, output.slice(-4000))
  console.log(
    "PASS native Activity/webhook outcomes, actual previous-version read fallback and composed gateway routing through real PersonalAgent objects."
  )
  const website = (path, body) =>
    fetch(
      `${origin}/website/${path}`,
      body === undefined
        ? undefined
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
    )
  const websiteState = await website("state")
  assert.equal(websiteState.status, 200, await websiteState.clone().text())
  assert.equal(typeof (await websiteState.json()).connected, "boolean")
  assert.equal(websiteState.headers.get("cache-control"), "private, no-store")
  const generatedId = "00000000-0000-4000-8000-000000008001"
  const generatedDraft = await website("apps/save", {
    id: generatedId,
    operationId: "00000000-0000-4000-8000-000000008002",
    expectedRevision: 0,
    definition: {
      title: "Native web app",
      description: "Synthetic local app",
      blocks: [
        {
          id: "counter",
          type: "web",
          initialState: '{"count":0}',
          code: '// native-web-app\nreturn {html:"<button data-action=add>Add</button>",css:"",state:JSON.stringify({count:input.state.count+1}),summary:"Updated"}',
        },
      ],
    },
  })
  assert.equal(generatedDraft.status, 200, await generatedDraft.clone().text())
  const generatedPublished = await website("apps/publish", {
    id: generatedId,
    operationId: "00000000-0000-4000-8000-000000008003",
    expectedRevision: (await generatedDraft.json()).revision,
    version: 1,
  })
  assert.equal(
    generatedPublished.status,
    200,
    await generatedPublished.clone().text()
  )
  const generated = await generatedPublished.json()
  const rendered = await website("apps/render", { id: generatedId, version: 1 })
  assert.equal(rendered.status, 200, await rendered.clone().text())
  assert.match((await rendered.json()).html, /data-action="add"/)
  const interaction = {
    id: generatedId,
    version: 1,
    expectedRevision: generated.revision,
    operationId: "00000000-0000-4000-8000-000000008004",
    action: { type: "web", blockId: "counter", name: "add", values: {} },
  }
  const applied = await website("apps/interact", interaction)
  assert.equal(applied.status, 200, await applied.clone().text())
  const appliedApp = await applied.json()
  assert.equal(JSON.parse(appliedApp.state.web.counter).count, 1)
  const beforeReplay = await (await fetch(`${origin}/website-probe`)).json()
  assert.equal(beforeReplay.code.calls, 2)
  const replayed = await website("apps/interact", interaction)
  assert.deepEqual(await replayed.json(), appliedApp)
  const afterReplay = await (await fetch(`${origin}/website-probe`)).json()
  assert.equal(afterReplay.code.calls, beforeReplay.code.calls)
  const webPty = await website("terminal/session", { id: "native-website-pty" })
  assert.equal(webPty.status, 202, await webPty.clone().text())
  for (let n = 0; n < 40; n++) {
    const terminal = await (await website("terminal")).json()
    if (terminal.session?.phase === "ready") break
    if (n === 39)
      throw new Error("Website Terminal session did not become ready")
    await sleep(25)
  }
  const websitePanel = new WebSocket(
    `${origin.replace("http:", "ws:")}/website/terminal/session/native-website-pty/socket`
  )
  websitePanel.binaryType = "arraybuffer"
  await socketEvent(websitePanel, "open")
  const websiteEcho = socketEvent(websitePanel, "message")
  websitePanel.send(Uint8Array.of(67, 68))
  assert.deepEqual(
    new Uint8Array((await websiteEcho).data),
    Uint8Array.of(67, 68)
  )
  const websiteResize = socketEvent(websitePanel, "message")
  websitePanel.send(resize)
  assert.equal((await websiteResize).data, resize)
  const websiteClosed = socketEvent(websitePanel, "close")
  await fetch(`${origin}/website-session`, { method: "POST" })
  assert.equal((await websiteClosed).code, 1008)
  const sessionReads = await (await fetch(`${origin}/website-session`)).json()
  await sleep(5500)
  assert.equal(
    (await (await fetch(`${origin}/website-session`)).json()).reads,
    sessionReads.reads
  )
  console.log(
    "PASS native website -> Agent gateway -> PersonalAgent -> Terminal: private HTTP, actual generated app execution and replay, real upgraded binary/resize relay, fresh session revocation and stopped rechecks."
  )
  let stoppedPersonal = await call("personal/stop", a)
  assert(["stopping", "cancelled"].includes(stoppedPersonal.stopped.status))
  assert.equal(stoppedPersonal.stopped.session_id, null)
  for (
    let n = 0;
    n < 100 && stoppedPersonal.stopped.status !== "cancelled";
    n++
  ) {
    await sleep(25)
    stoppedPersonal = await call("personal/inspect", a)
  }
  assert.equal(stoppedPersonal.stopped.status, "cancelled")
  assert.equal((await call("personal/delegation-start", a)).status, 202)
  let nativeDelegation
  for (let n = 0; n < 100; n++) {
    nativeDelegation = await call("personal/delegation-read", a)
    if (nativeDelegation.turn?.status === "done") break
    await sleep(50)
  }
  assert.equal(
    nativeDelegation.turn?.answer,
    "Native delegation complete",
    JSON.stringify(nativeDelegation) + output.slice(-4000)
  )
  assert.equal(nativeDelegation.groups.length, 1)
  assert.equal(nativeDelegation.groups[0].status, "completed")
  assert.equal(nativeDelegation.groups[0].children.length, 2)
  assert(
    nativeDelegation.groups[0].children.every(
      (child) =>
        child.status === "completed" &&
        child.answer === "Native child findings" &&
        child.requests === 1 &&
        child.tools.length === 0
    )
  )
  assert.equal((await call("personal/background-start", a)).status, 202)
  let nativeBackgroundWorkflow
  for (let n = 0; n < 200; n++) {
    nativeBackgroundWorkflow = await call("personal/background-read", a)
    if (
      nativeBackgroundWorkflow.parent?.status === "done" &&
      nativeBackgroundWorkflow.report?.status === "done" &&
      conversationReleased(nativeBackgroundWorkflow.parent) &&
      conversationReleased(nativeBackgroundWorkflow.report)
    )
      break
    await sleep(50)
  }
  assert.equal(nativeBackgroundWorkflow.parent?.status, "done")
  assert.equal(nativeBackgroundWorkflow.report?.status, "done")
  assert(
    conversationReleased(nativeBackgroundWorkflow.parent) &&
      conversationReleased(nativeBackgroundWorkflow.report),
    JSON.stringify(nativeBackgroundWorkflow) + output.slice(-4000)
  )
  assert.equal(
    nativeBackgroundWorkflow.parent?.answer,
    "Native background accepted",
    JSON.stringify(nativeBackgroundWorkflow) + output.slice(-4000)
  )
  assert.equal(
    nativeBackgroundWorkflow.row?.status,
    "delivered",
    JSON.stringify(nativeBackgroundWorkflow) + output.slice(-4000)
  )
  assert.equal(nativeBackgroundWorkflow.group.status, "completed")
  assert.equal(nativeBackgroundWorkflow.group.children.length, 2)
  assert(
    nativeBackgroundWorkflow.group.children.every(
      (child) =>
        child.status === "completed" &&
        child.answer === "Native background child findings" &&
        child.requests === 1 &&
        child.tools.length === 0
    )
  )
  assert.equal(
    nativeBackgroundWorkflow.report.answer,
    "Native background findings reconciled"
  )
  assert.deepEqual(nativeBackgroundWorkflow.report.origin, {
    kind: "background",
    groupId: nativeBackgroundWorkflow.row.id,
    turnId: "native-background-workflow",
  })
  const nativeActivity = await call("personal/activity", a)
  assert.equal(nativeActivity.pageStatus, 200)
  assert.equal(nativeActivity.recordStatus, 200)
  assert(nativeActivity.page.entries.length > 0)
  assert.deepEqual(nativeActivity.page.unavailable, [])
  assert.equal(nativeActivity.before, nativeActivity.after)
  assert.equal(nativeActivity.record.id, nativeBackgroundWorkflow.report.id)
  assert.equal(nativeActivity.record.source, "background")
  assert.equal(
    nativeActivity.record.run.runId,
    nativeBackgroundWorkflow.report.id
  )
  assert.equal(
    nativeActivity.record.answer,
    "Native background findings reconciled"
  )
  assert(
    nativeActivity.page.entries.every(
      (entry) => entry.agent.id === "home" && entry.key.startsWith("home:")
    )
  )
  let nativeBackground = await call("personal/background-mailbox", a)
  for (
    let n = 0;
    n < 100 &&
    (nativeBackground.turn?.status !== "done" ||
      !conversationReleased(nativeBackground.turn));
    n++
  ) {
    await sleep(25)
    nativeBackground = {
      ...nativeBackground,
      ...(await call("personal/background-mailbox-read", a)),
    }
  }
  assert(
    conversationReleased(nativeBackground.turn),
    JSON.stringify(nativeBackground) + output.slice(-4000)
  )
  assert.equal(nativeBackground.rolledBack, true)
  assert.equal(nativeBackground.delivered, true)
  assert.equal(nativeBackground.replay, false)
  assert.equal(nativeBackground.row.status, "delivered")
  assert.equal(nativeBackground.turn.status, "done")
  assert.equal(
    nativeBackground.turn.answer,
    "Native background report acknowledged"
  )
  assert.deepEqual(nativeBackground.turn.origin, {
    kind: "background",
    groupId: 910001,
    turnId: "native-background-parent",
  })
  assert.deepEqual(
    nativeBackground.turn.routing,
    nativeBackground.row.handoff.route
  )
  const retriedPersonal = await call("personal/retry", a)
  assert.equal(retriedPersonal.retry.revision, 2)
  assert.equal(retriedPersonal.retry.versions, 2)
  const nativeMemory = await call("personal/memory", a)
  assert.equal(nativeMemory.firstStatus, 200)
  assert.equal(nativeMemory.first.added, 1)
  assert.equal(nativeMemory.replayStatus, 200)
  assert.equal(nativeMemory.replay.added, 0)
  assert.equal(nativeMemory.search.length, 1)
  assert.equal(nativeMemory.search[0].text, "Native imported 🍀")
  assert.equal(nativeMemory.search[0].date, "2020-01-02T10:00:00Z")
  assert(Array.isArray(nativeMemory.tree))
  assert.deepEqual(nativeMemory.memoryTools, [
    "zoom",
    "date",
    "search_memory",
    "read_note",
    "write_note",
  ])
  const nativeProfiles = await call("personal/profiles", a)
  assert.equal(nativeProfiles.firstStatus, 200)
  assert.equal(nativeProfiles.replayStatus, 200)
  assert.equal(nativeProfiles.first.id, nativeProfiles.replay.id)
  assert.equal(nativeProfiles.first.createdAt, nativeProfiles.replay.createdAt)
  assert.equal(nativeProfiles.updated.name, "Native updated")
  assert.equal(nativeProfiles.updated.revision, 1)
  assert.equal(nativeProfiles.homeArchive, 409)
  assert.deepEqual(nativeProfiles.projection, { revision: 2, active: true })
  assert.equal(nativeProfiles.released, 1)
  assert.equal((await call("personal/command-start", a)).status, 202)
  let piCommand
  for (let n = 0; n < 120; n++) {
    piCommand = await call("personal/command-read", a)
    if (
      piCommand.command?.status === "done" &&
      conversationReleased(piCommand.command)
    )
      break
    if (piCommand.command?.status === "failed")
      throw new Error(JSON.stringify(piCommand) + output.slice(-4000))
    await sleep(50)
  }
  assert.equal(piCommand.command?.status, "done")
  assert(
    conversationReleased(piCommand.command),
    JSON.stringify(piCommand) + output.slice(-4000)
  )
  assert.equal(
    piCommand.command.answer,
    "Native Pi command complete",
    JSON.stringify(piCommand) + output.slice(-4000)
  )
  assert.deepEqual(piCommand.terminal.commands, [{ command: "printf fixture" }])
  assert.equal((await call("personal/command-hold", a)).status, 202)
  let heldCommand
  for (let n = 0; n < 100; n++) {
    heldCommand = await call("personal/command-pending", a)
    if (heldCommand.probe.entered) break
    await sleep(25)
  }
  assert(heldCommand.probe.entered)
  const heldBackground = await call("personal/background-held-start", a)
  assert.equal(heldBackground.id, 910002)
  let backgroundProvider
  for (let n = 0; n < 120; n++) {
    backgroundProvider = await call("personal/background-held-inspect", a)
    if (backgroundProvider.entered) break
    await sleep(50)
  }
  assert(
    backgroundProvider.entered,
    JSON.stringify(backgroundProvider) + output.slice(-5000)
  )
  const closingBackground = call("personal/background-held-dispose", a).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  for (let n = 0; n < 100; n++) {
    backgroundProvider = await call("personal/background-held-inspect", a)
    if (backgroundProvider.aborted && backgroundProvider.cleaning) break
    await sleep(25)
  }
  assert(backgroundProvider.aborted)
  assert(backgroundProvider.cleaning)
  assert(!backgroundProvider.closed)
  assert(!backgroundProvider.disposed)
  assert(backgroundProvider.runtimeOpen)
  await call("personal/background-held-release", a)
  const backgroundClosed = await closingBackground
  if ("error" in backgroundClosed) throw backgroundClosed.error
  const closedBackground = backgroundClosed.value
  assert(closedBackground.closed)
  assert(closedBackground.disposed)
  assert(!closedBackground.runtimeOpen)
  assert.equal(closedBackground.calls, 1)
  assert.equal(closedBackground.callbacksAfterClose, 0)
  assert.equal(closedBackground.attempts.length, 1)
  assert.equal(closedBackground.attempts[0].outcome, "cancelled")
  await call("personal/background-held-cancel", a)
  const stoppingCommand = call("personal/command-stop", a).then(
    (value) => ({ value }),
    (error) => ({ error })
  )
  for (let n = 0; n < 100; n++) {
    heldCommand = await call("personal/command-pending", a)
    if (
      heldCommand.probe.aborted &&
      heldCommand.terminal.cancellations.some((row) =>
        row.id.startsWith("command:")
      )
    )
      break
    await sleep(25)
  }
  assert(
    heldCommand.probe.aborted,
    JSON.stringify(heldCommand) + output.slice(-3000)
  )
  assert(
    heldCommand.terminal.cancellations.some((row) =>
      row.id.startsWith("command:")
    )
  )
  await call("personal/command-release", a)
  const stoppedCommand = await stoppingCommand
  if ("error" in stoppedCommand) throw stoppedCommand.error
  for (let n = 0; n < 100; n++) {
    heldCommand = await call("personal/command-read", a)
    if (
      heldCommand.stopped?.status === "cancelled" &&
      conversationReleased(heldCommand.stopped)
    )
      break
    await sleep(25)
  }
  assert.equal(heldCommand.stopped.status, "cancelled")
  assert(
    conversationReleased(heldCommand.stopped),
    JSON.stringify(heldCommand) + output.slice(-4000)
  )
  assert.deepEqual(heldCommand.terminal.commands, piCommand.terminal.commands)
  console.log(
    "PASS native Pi run_command completion/Stop fencing and BackgroundGroup active provider shutdown joins held reader cleanup before runtime disposal."
  )
  const nativeFile = await call("personal/files", a)
  assert.equal(nativeFile.firstStatus, 201)
  assert.equal(nativeFile.replayStatus, 201)
  assert.deepEqual(nativeFile.first, nativeFile.replay)
  assert.equal(nativeFile.renamed.name, "renamed.md")
  assert.equal(nativeFile.content.text, "Native private file 🍀")
  assert.equal(nativeFile.trashedStatus, 404)
  assert(!JSON.stringify(nativeFile.first).includes("hash"))
  assert.equal(nativeFile.pdf.extraction.status, "ready")
  assert.equal(nativeFile.pdf.extraction.pages, 1)
  assert.equal(nativeFile.video.video.status, "ready")
  assert.equal(nativeFile.video.video.frames, 1)
  const nativeTransfer = await call("personal/terminal-import", a)
  assert.equal(nativeTransfer.firstStatus, 202)
  assert.equal(nativeTransfer.replayStatus, 202)
  assert.equal(nativeTransfer.first.id, nativeTransfer.replay.id)
  assert.equal(nativeTransfer.replay.transfer.name, "renamed.md")
  assert.equal(nativeTransfer.conflict, 409)
  assert.equal(nativeTransfer.exporting, 202)
  assert.equal(nativeTransfer.cancelled, 202)
  assert.equal(nativeTransfer.state.imports.length, 1)
  assert.equal(nativeTransfer.state.commands.length, 1)
  assert.equal(nativeTransfer.state.imports[0].text, "Native private file 🍀")
  assert.equal(nativeTransfer.receipt.status, "succeeded")
  assert.equal(nativeTransfer.downloadStatus, 200)
  assert.equal(nativeTransfer.download, "Native transfer 🍀")
  assert(
    nativeTransfer.state.state.runs.some(
      (run) => run.id.endsWith("019") && run.status === "cancelled"
    )
  )
  const nativeObjects = await call("personal/objects", a)
  assert.equal(nativeObjects.firstStatus, 200)
  assert.equal(nativeObjects.replayStatus, 200)
  assert.deepEqual(nativeObjects.first, nativeObjects.replay)
  assert.equal(nativeObjects.updated.revision, 2)
  assert.equal(nativeObjects.staleStatus, 409)
  assert.equal(nativeObjects.stale.code, "conflict")
  assert.equal(nativeObjects.context.sequence, 2)
  assert.equal(nativeObjects.context.offeredThrough, 2)
  const nativePlan = await call("personal/planning", a)
  assert.equal(nativePlan.first.revision, 1)
  assert.equal(nativePlan.first.state, "completed")
  assert.deepEqual(nativePlan.first, nativePlan.replay)
  assert.equal(nativePlan.status, 200)
  assert.equal(nativePlan.reopened.plan.revision, 2)
  assert.equal(nativePlan.reopened.plan.state, "open")
  assert.equal(nativePlan.reopened.plan.steps[0].status, "pending")
  assert.equal(nativePlan.reopened.history[0].reason, "Evidence revalidated")
  assert.equal(nativePlan.cancelled.plan.revision, 3)
  assert.equal(nativePlan.cancelled.plan.state, "cancelled")
  const nativeExport = await call("personal/export", a)
  assert.equal(nativeExport.status, 200)
  assert.equal(nativeExport.cache, "private, no-store")
  assert.equal(nativeExport.contentType, "application/x-ndjson")
  assert.equal(nativeExport.header.format, "durable-pi-memory")
  assert.deepEqual(nativeExport.header.until, nativeExport.footer.until)
  assert.equal(nativeExport.answerPresent, true)
  const nativeCode = await call("personal/code", a)
  assert.equal(nativeCode.first, 202)
  assert.equal(nativeCode.replay, 202)
  assert.equal(nativeCode.saved.status, "succeeded")
  assert.equal(nativeCode.saved.output.result, "3")
  assert.equal(nativeCode.calls, 1)
  const nativeUsage = await call("personal/usage-start", a)
  assert.equal(nativeUsage.attempts.length, 2)
  const finishedUsage = nativeUsage.attempts.find(
    (attempt) => attempt.purpose === "conversation"
  )
  assert.equal(finishedUsage.outcome, "cancelled")
  assert.equal(finishedUsage.error, "Stopped by user")
  assert.equal(finishedUsage.input, 123)
  assert.equal(finishedUsage.output, 17)
  assert.equal(nativeUsage.reports.length, 1)
  assert.deepEqual(nativeUsage.totals, {
    modelRequests: 2,
    usageReportedRequests: 1,
    knownInputTokens: 123,
    knownCachedInputTokens: 100,
    knownOutputTokens: 17,
  })
  await call("personal-code/uncertain-code", b)
  await call("personal/hold-code", a)
  await call("personal/hold-provider", a)
  await call("personal-credential/credential-start", b)
  await call("personal/credential-start", a)
  await call("personal/hold", a)
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (
      personal.watchAttached &&
      personal.summaryEntered &&
      personal.exportEntered &&
      personal.download.entered &&
      personal.code.entered &&
      personal.credential.entered &&
      personal.provider.entered
    )
      break
    await sleep(25)
  }
  assert(personal.watchAttached, "Native SSE did not acquire its stream")
  assert(personal.summaryEntered, "Native summary did not acquire its request")
  assert(personal.exportEntered, "Native export did not read its archive page")
  assert(personal.download.entered, "Native download did not acquire its body")
  const disposing = call("personal/dispose", a)
  void disposing.catch(() => {})
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (personal.credential.aborted) break
    await sleep(25)
  }
  assert(personal.credential.aborted)
  assert(!personal.credential.settled)
  assert(!personal.events.includes("host.dispose"))
  await call("personal/release-credential", a)
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (personal.provider.aborted && personal.provider.cleaning) break
    await sleep(25)
  }
  assert(personal.provider.aborted)
  assert(personal.provider.cleaning)
  assert(!personal.provider.closed)
  assert(!personal.events.includes("host.dispose"))
  await call("personal/release-provider", a)

  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (
      personal.events.includes("communication.stop") &&
      personal.stopEntered &&
      personal.summaryAborted &&
      personal.exportCleanupEntered &&
      personal.download.cleaning &&
      personal.code.aborted
    )
      break
    await sleep(25)
  }
  assert(personal.events.includes("communication.stop"))
  assert(personal.stopEntered)
  assert(personal.summaryAborted)
  assert(personal.exportCleanupEntered)
  assert(personal.download.cleaning)
  assert(!personal.events.includes("actor.connections.close"))
  assert(!personal.events.includes("host.dispose"))
  await call("personal/release", a)
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (
      personal.events.includes("native.summary.settled") &&
      personal.events.includes("native.stream.stop") &&
      personal.events.includes("native.export.settled")
    )
      break
    await sleep(25)
  }
  assert(!personal.download.closed)
  assert(!personal.events.includes("actor.connections.close"))
  await call("personal/release-download", a)
  for (let n = 0; n < 100; n++) {
    personal = await call("personal/inspect", a)
    if (personal.download.closed) break
    await sleep(25)
  }
  assert(personal.download.closed)
  assert(personal.code.aborted)
  assert(!personal.code.settled)
  // This marker observes the independent Access connection Layer, not all
  // actor services. Execution owns no MCP connection; its real host must wait.
  assert(!personal.events.includes("host.dispose"))
  await call("personal/release-code", a)
  const disposed = await disposing
  assert(disposed.provider.closed)
  assert(disposed.provider.settled)
  assert(disposed.provider.interrupted)
  assert.equal(disposed.provider.attempt.outcome, "cancelled")
  assert(
    disposed.events.indexOf("native.provider.closed") <
      disposed.events.indexOf("communication.stop")
  )
  assert(disposed.credential.settled)
  assert(disposed.credential.interrupted)
  assert.equal(disposed.credential.pending, 1)
  assert(disposed.code.settled)
  assert.equal(JSON.parse(disposed.code.saved).status, "interrupted")
  assert(disposed.download.closed)
  assert(disposed.download.interrupted)
  assert(disposed.observationInterrupted)
  assert(disposed.summaryInterrupted)
  assert(disposed.exportInterrupted)
  assert.equal(disposed.heldSummaryBuilt, false)
  assert(disposed.events.lastIndexOf("native.summary.settled") >= 0)
  assert(
    disposed.events.lastIndexOf("native.summary.settled") <
      disposed.events.indexOf("actor.connections.close")
  )
  assert(
    disposed.events.indexOf("native.stream.stop") <
      disposed.events.indexOf("actor.connections.close")
  )
  assert(disposed.events.indexOf("native.export.settled") >= 0)
  assert(
    disposed.events.indexOf("native.export.settled") <
      disposed.events.indexOf("actor.connections.close")
  )
  assert(
    disposed.events.indexOf("actor.connections.close") <
      disposed.events.indexOf("host.dispose")
  )
  await stop()
  await start()
  const coldCredential = await call("personal-credential/credential-replay", b)
  assert(coldCredential.blocked)
  assert.equal(coldCredential.calls, 0)
  assert.equal(coldCredential.attempts, 1)
  assert.equal(coldCredential.pending, 1)
  const replayCode = await call("personal-code/replay-code", b)
  assert.equal(replayCode.run.status, "interrupted")
  assert.equal(replayCode.calls, 0)
  const completedCode = await call("personal/code", a)
  assert.equal(completedCode.saved.status, "succeeded")
  assert.equal(completedCode.calls, 0)
  const restoredUsage = await call("personal/usage-read", a)
  const restoredFinishedUsage = restoredUsage.attempts.find(
    (attempt) => attempt.id === finishedUsage.id
  )
  assert.deepEqual(restoredFinishedUsage, finishedUsage)
  assert.equal(
    restoredUsage.attempts.find((attempt) => attempt.purpose === "compaction")
      .outcome,
    "interrupted"
  )
  assert.deepEqual(restoredUsage.totals, nativeUsage.totals)
  assert.deepEqual(restoredUsage.reports, nativeUsage.reports)
  const restoredDelegation = await call("personal/delegation-read", a)
  assert.deepEqual(restoredDelegation.groups, nativeDelegation.groups)
  assert.equal(restoredDelegation.turn.answer, "Native delegation complete")
  assert.deepEqual(await call("personal/background-mailbox-read", a), {
    row: nativeBackground.row,
    turn: nativeBackground.turn,
  })
  assert.deepEqual(
    await call("personal/background-read", a),
    nativeBackgroundWorkflow
  )
  const restoredActivity = await call("personal/activity", a)
  assert.equal(restoredActivity.before, restoredActivity.after)
  assert.deepEqual(restoredActivity.record, nativeActivity.record)
  const personalRestored = await call("personal/inspect", a)
  assert.equal(personalRestored.turn.status, "done")
  assert.equal(personalRestored.turn.answer, "Native actor answer")
  assert.equal(personalRestored.attempts, 1)
  assert.equal(personalRestored.stopped.status, "cancelled")
  assert.equal(personalRestored.stopped.session_id, null)
  assert.equal(personalRestored.retry.revision, 2)
  assert.equal(personalRestored.retry.versions, 2)
  // Compare this restart with the last observed instance. Other native probes
  // can reactivate the object before this deliberate process restart.
  assert.equal(personalRestored.activations, disposed.activations + 1)
  assert.equal(personalRestored.externalCalls, 0)
  assert.equal(personalRestored.catalog.name, "Native updated")
  assert.equal(personalRestored.catalog.revision, 1)
  const restoredCommand = await call("personal/command-read", a)
  assert.deepEqual(restoredCommand.command, piCommand.command)
  assert.deepEqual(restoredCommand.stopped, heldCommand.stopped)
  assert.deepEqual(
    restoredCommand.terminal.commands,
    piCommand.terminal.commands
  )
  const restoredTransfer = await call("personal/terminal-read", a)
  assert.deepEqual(
    await (await terminalFetch("inspect")).json(),
    nativeTerminalState
  )
  assert.deepEqual(
    await (await terminalFetch("client", {})).json(),
    nativeCommand
  )
  assert.equal(restoredTransfer.replayStatus, 202)
  assert.deepEqual(restoredTransfer.receipt, nativeTransfer.receipt)
  assert.deepEqual(restoredTransfer.replay, nativeTransfer.receipt)
  assert.deepEqual(restoredTransfer.state, nativeTransfer.state)
  assert.equal(restoredTransfer.downloadStatus, 200)
  assert.equal(restoredTransfer.download, nativeTransfer.download)
  const restoredFile = await call("personal/file-read", a)
  assert.equal(restoredFile.status, 200)
  assert.equal(restoredFile.list.files.length, 3)
  const restoredText = restoredFile.list.files.find(
    (file) => file.id === nativeFile.first.id
  )
  assert.equal(restoredText.createdAt, nativeFile.first.createdAt)
  assert.equal(restoredText.name, "renamed.md")
  assert.equal(restoredText.trashed, false)
  assert.equal(restoredText.status, "ready")
  assert.equal(
    restoredFile.list.files.find((file) => file.id === nativeFile.pdf.id)
      .extraction.status,
    "ready"
  )
  assert.equal(
    restoredFile.list.files.find((file) => file.id === nativeFile.video.id)
      .video.status,
    "ready"
  )
  const restoredObject = await call("personal/object-read", a)
  assert.equal(restoredObject.status, 200)
  assert.equal(restoredObject.detail.object.title, "Native planning revision")
  assert.equal(restoredObject.detail.object.revision, 3)
  assert.equal(restoredObject.detail.events.length, 3)
  assert.equal(restoredObject.context.sequence, 3)
  assert.equal(restoredObject.context.offeredThrough, 2)
  const restoredPlan = await call("personal/plan-read", a)
  assert.equal(restoredPlan.status, 200)
  assert.equal(restoredPlan.detail.plan.revision, 3)
  assert.equal(restoredPlan.detail.plan.state, "cancelled")
  assert.equal(restoredPlan.detail.history.length, 3)
  const restoredMemory = await call("personal/memory", a)
  assert.equal(restoredMemory.first.added, 0)
  assert.equal(restoredMemory.replay.added, 0)
  assert.equal(restoredMemory.search.length, 1)
  assert.equal(restoredMemory.search[0].text, "Native imported 🍀")
  assert.equal(restoredMemory.search[0].date, "2020-01-02T10:00:00Z")
  console.log(
    `PASS full PersonalAgent: native actor Layer activation (${disposed.activations} -> ${personalRestored.activations} across restart), conversation pump, Pi completion, real parent/two-child delegation and sealed restart state, real parent/background-DO/two-child execution and report reconciliation with exact restart state, atomic background report admission/acknowledgement, read-only Activity HTTP/RPC and exact saved-run restart state, Terminal HTTP/import/export/cancel with exact receipt and byte restart state, private archive export, code HTTP replay and uncertain-intent recovery without redispatch, credential rotation intent survives SIGKILL without refresh replay, usage terminal fences and deduplicated totals survive restart, ordered disposal joining held provider/credential/SSE/summary/export/download/execution work, and fresh activation after restart without another conversation model request.`
  )
  console.log(
    `PASS workerd ${workerd.version}: private Effect RPC, two SQLite DOs, sender restart before delivery, lost acknowledgment after acceptance, recipient/result-delivery restart, unique task admission, invalid/version/owner rejection native Pi interruption/recovery, single continuation and coexisting Pi/Lifecycle alarms.`
  )
} finally {
  await stop()
  await rm(dir, { recursive: true, force: true })
}
