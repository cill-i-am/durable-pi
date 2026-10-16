import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"

const origin = process.env.NATIVE_SANDBOX_URL ?? "http://localhost:1342"
const headers = process.env.SANDBOX_REHEARSAL_TOKEN
  ? { authorization: "Bearer " + process.env.SANDBOX_REHEARSAL_TOKEN }
  : {}
const identity = randomBytes(32).toString("hex")
const sibling = randomBytes(32).toString("hex")
const call = async (path, body, owner = identity) => {
  const response = await fetch(`${origin}/${owner}/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  })
  assert(
    response.ok,
    `Rehearsal ${path}: ${response.status} ${await response.clone().text()}`
  )
  return response.json()
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const state = () => call("terminal")
async function wait(id) {
  for (let n = 0; n < 180; n++) {
    const [run, current] = await Promise.all([call(`terminal/${id}`), state()])
    if (run.status !== "running" && !current.busy) return run
    await sleep(250)
  }
  throw new Error("Native command and cleanup did not settle")
}
const execute = async (command) => {
  const input = { id: randomUUID(), command }
  await call("terminal/run", input)
  return { input, result: await wait(input.id) }
}
await call("authority", { revision: 1, active: true })
const policy = (await state()).networkPolicy
await call("terminal/network", {
  revision: policy.revision,
  unrestricted: false,
})
assert.equal((await state()).networkPolicy.unrestricted, false)
const first = await execute(
  "printf 'native checkpoint' > /workspace/proof; printf 'native output'"
)
assert.equal(first.result.status, "succeeded", JSON.stringify(first.result))
assert.equal(first.result.output, "native output")
assert(first.result.savedAt)
const restored = await execute("cat /workspace/proof; printf ' café 🧭'")
assert.equal(restored.result.output, "native checkpoint café 🧭")
await call("terminal/run", first.input)
assert.equal((await state()).runs.length, 2)
assert.equal((await call("terminal", undefined, sibling)).runs.length, 0)
const blocked = await execute(
  "curl --connect-timeout 2 --max-time 3 https://example.com"
)
assert.equal(blocked.result.status, "failed")
assert.notEqual(blocked.result.exitCode, 0)
const stopped = {
  id: randomUUID(),
  command: "printf 'must not persist' > /workspace/proof; sleep 60",
}
await call("terminal/run", stopped)
await sleep(1000)
await call(`terminal/${stopped.id}/cancel`, {})
assert.equal((await wait(stopped.id)).status, "cancelled")
assert.equal(
  (await execute("cat /workspace/proof")).result.output,
  "native checkpoint"
)
const session = randomUUID()
await call("terminal/session", { id: session })
for (let n = 0; n < 100; n++) {
  if ((await state()).session?.phase === "ready") break
  assert(n < 99, "Native interactive session did not become ready")
  await sleep(100)
}
async function openTerminal(sessionId = session) {
  const socket = new WebSocket(
    `${origin.replace(/^http/, "ws")}/${identity}/terminal/session/${sessionId}/socket`,
    { headers }
  )
  socket.binaryType = "arraybuffer"
  let text = "",
    ready = false
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      ready ||= event.data === '{"type":"ready"}'
      return
    }
    text += new TextDecoder().decode(event.data)
  })
  for (let n = 0; n < 100 && !ready; n++) {
    assert(n < 99, "Native socket did not become ready")
    await sleep(100)
  }
  return {
    socket,
    send: (command) =>
      socket.send(new TextEncoder().encode(command.replaceAll("\n", "\r"))),
    wait: async (value) => {
      for (
        let n = 0;
        n < 100 &&
        !text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").includes(value);
        n++
      ) {
        assert(
          n < 99,
          `Native shell did not output ${value}: ${text.slice(-1000)}`
        )
        await sleep(100)
      }
    },
    close: () =>
      new Promise((resolve) => {
        socket.addEventListener("close", resolve, { once: true })
        socket.close()
      }),
  }
}
let terminal = await openTerminal()
terminal.socket.send(JSON.stringify({ type: "resize", cols: 99, rows: 34 }))
terminal.send("stty size\n")
await terminal.wait("34 99")
terminal.send("sleep 60\n")
await sleep(200)
terminal.socket.send(Uint8Array.of(3))
terminal.send(
  "printf '\\141\\146\\164\\145\\162\\040\\151\\156\\164\\145\\162\\162\\165\\160\\164\\n'\n"
)
await terminal.wait("after interrupt")
terminal.send(
  "printf 'interactive checkpoint' > /workspace/proof; printf '\\167\\162\\151\\164\\164\\145\\156\\n'\n"
)
await terminal.wait("written")
await terminal.close()
await call(`terminal/session/${session}/renew`, {})
terminal = await openTerminal()
terminal.send("cat /workspace/proof; printf '\\n'\n")
await terminal.wait("interactive checkpoint")
await terminal.close()
await call(`terminal/session/${session}/save`, {})
for (let n = 0; n < 100; n++) {
  if (!(await state()).session) break
  assert(n < 99, "Native Save did not settle")
  await sleep(100)
}
assert.equal(
  (await execute("cat /workspace/proof")).result.output,
  "interactive checkpoint"
)
const discarded = randomUUID()
await call("terminal/session", { id: discarded })
for (let n = 0; n < 100; n++) {
  if ((await state()).session?.phase === "ready") break
  assert(n < 99, "Discard session did not become ready")
  await sleep(100)
}
terminal = await openTerminal(discarded)
terminal.send(
  "printf 'must be discarded' > /workspace/proof; printf '\\144\\151\\163\\143\\141\\162\\144\\040\\162\\145\\141\\144\\171\\n'\n"
)
await terminal.wait("discard ready")
await terminal.close()
await call(`terminal/${discarded}/cancel`, {})
assert.equal((await wait(discarded)).status, "cancelled")
assert.equal(
  (await execute("cat /workspace/proof")).result.output,
  "interactive checkpoint"
)

const fixture = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "durable-pi-ci:terminal-native",
    "ffmpeg",
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=5",
    "-t",
    "1",
    "-c:v",
    "libvpx",
    "-threads",
    "1",
    "-f",
    "webm",
    "pipe:1",
  ],
  { maxBuffer: 1048576, timeout: 15000 }
)
assert.equal(fixture.status, 0, fixture.stderr.toString())
const videoResponse = await fetch(`${origin}/${identity}/video`, {
  method: "POST",
  headers,
  body: fixture.stdout,
  signal: AbortSignal.timeout(45000),
})
assert.equal(videoResponse.status, 200, await videoResponse.clone().text())
const video = await videoResponse.json()
assert(video.frames.length > 0)
assert(
  video.frames.every(
    (frame) => typeof frame.jpeg === "string" && frame.jpeg.length < 33000
  )
)
console.log(
  "PASS native Sandbox rehearsal: real commands, UTF-8, checkpoint restore, replay without redispatch, sibling isolation, blocked internet, Stop and rollback, native PTY resize/Ctrl+C/reconnect, Save/Discard, and real video decoding."
)
